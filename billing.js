/* ═══════════════════════════════════════════════════════════════════
   Crafty Planner — Google Play Billing integration
   ═══════════════════════════════════════════════════════════════════

   Handles the Digital Goods API + Payment Request API flow for
   Play Store-distributed TWAs. When the app is opened in a context
   WITHOUT Play Billing (desktop Chrome, direct-PWA install, iOS Safari),
   the upgrade path gracefully falls back to a "please install from Play
   Store" message.

   Key concepts:
   - "Available": Digital Goods API exists on window (we're inside a TWA).
   - "Pro": the user currently has an active crafty_pro_monthly subscription.
   - Purchase MUST be acknowledged within 3 days or Google auto-refunds.

   Depends on: isPro(), getProfile(), saveProfile(), applyProfile(),
   showToast(), closeModal(), render() — all defined in index.html.
   =================================================================== */

const CP_BILLING = (function(){
  const PRODUCT_ID = 'crafty_pro_monthly';
  const BILLING_SERVICE = 'https://play.google.com/billing';
  const CACHE_KEY = 'cp-pro-lastcheck';
  const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

  /* Diagnostic toast — long-lived, word-wrapping, readable on phone.
     Remove this whole function after billing is confirmed working. */
  function showDiagnosticToast(text){
    const existing = document.getElementById('cp-diag-toast');
    if(existing)existing.remove();
    const t = document.createElement('div');
    t.id = 'cp-diag-toast';
    t.style.cssText = 'position:fixed;bottom:100px;left:12px;right:12px;background:#1a1a1a;color:#ff9;padding:12px 16px;border-radius:10px;font-family:monospace;font-size:11px;line-height:1.4;z-index:10000;box-shadow:0 4px 16px rgba(0,0,0,0.3);word-break:break-word;white-space:pre-wrap;max-height:40vh;overflow-y:auto';
    t.textContent = '[billing diagnostic]\n' + text + '\n\n(tap to dismiss)';
    t.onclick = () => t.remove();
    document.body.appendChild(t);
    setTimeout(() => {if(t.parentNode)t.remove();}, 20000);
  }

  /* Persistent step logger — writes trace to localStorage AND cumulatively
     displays to screen. Survives errors, tab-switches, and page reloads.
     Call window.CP_BILLING_LOG() from the Tools tab (or anywhere) to
     inspect the full trace from the last session. */
  const STEP_LOG_KEY = 'cp-billing-steplog';
  function logStep(label, detail){
    try{
      const now = new Date().toISOString().slice(11,23);
      const line = now + ' ' + label + (detail != null ? ' :: ' + String(detail).slice(0, 200) : '');
      const prev = localStorage.getItem(STEP_LOG_KEY) || '';
      // Keep last ~5KB of log
      const combined = (prev + '\n' + line).slice(-5000);
      localStorage.setItem(STEP_LOG_KEY, combined);
      console.log('[CP_BILLING]', line);
    }catch(e){
      console.warn('logStep failed', e);
    }
  }
  // Expose a global for manual inspection from the app
  window.CP_BILLING_LOG = function(){
    const log = localStorage.getItem(STEP_LOG_KEY) || '(empty)';
    showDiagnosticToast('STEP LOG:\n' + log);
    return log;
  };
  // Clear the log at start of every session so we only see current run
  try{localStorage.setItem(STEP_LOG_KEY, '');}catch(e){}
  logStep('billing.js file loaded');

  /* Is the Digital Goods API available in this context?
     True only when running inside a Play-Store-installed TWA. */
  function isBillingAvailable(){
    return typeof window !== 'undefined' && 'getDigitalGoodsService' in window;
  }

  /* Get the Digital Goods service. Returns null if not in a Play Store context
     or if the service rejects our billing URL. */
  async function getService(){
    if(!isBillingAvailable())return null;
    try{
      return await window.getDigitalGoodsService(BILLING_SERVICE);
    }catch(e){
      console.warn('[billing] getDigitalGoodsService rejected:', e);
      return null;
    }
  }

  /* Acknowledgment for Digital Goods API purchases.
     v2 (current): consume() is for consumables only; subscriptions acknowledge
        automatically when response.complete('success') is called on PaymentRequest.
     v1 (deprecated): used acknowledge(token, type) explicitly.
     For subscriptions on v2: calling consume() is EXPECTED to fail — that's OK.
     Returns {ok, method, error, needed}. "needed=false" means no action required. */
  async function acknowledgePurchase(svc, purchaseToken){
    if(!purchaseToken)return {ok: false, method: null, error: 'no token', needed: true};

    // v1 path: if acknowledge() exists, use it — that's the old API
    if(typeof svc.acknowledge === 'function'){
      for(const flavor of ['onetime', 'repeatable']){
        try{
          await svc.acknowledge(purchaseToken, flavor);
          return {ok: true, method: 'acknowledge-' + flavor, error: null, needed: true};
        }catch(e){
          // try next flavor
        }
      }
      return {ok: false, method: null, error: 'all acknowledge flavors rejected', needed: true};
    }

    // v2 path: no acknowledge() exists. For subscriptions, no explicit ack is needed —
    // response.complete('success') handles it. We'll try consume() defensively for
    // any lingering unacknowledged states, but failure is EXPECTED and OK.
    if(typeof svc.consume === 'function'){
      try{
        await svc.consume(purchaseToken);
        return {ok: true, method: 'consume', error: null, needed: true};
      }catch(e){
        // consume() on a subscription is semantically wrong and will often fail.
        // Serialize the full error for diagnostics.
        let detail = '';
        try{detail = JSON.stringify(e, Object.getOwnPropertyNames(e));}
        catch(_){detail = String(e);}
        logStep('consume() rejected — OK for subs', detail);
        return {
          ok: true,                 // treat as OK: subscription doesn't need manual ack
          method: 'implicit (v2 sub)',
          error: null,
          needed: false,
          detail: detail
        };
      }
    }

    return {ok: false, method: null, error: 'no ack method available', needed: true};
  }

  /* Primary status check. Called on app load.
     Returns {available, isPro, reason} where reason explains any "not Pro" result. */
  async function checkProStatus(){
    // Dev toggle ALWAYS wins — used for local testing. Remove before launch.
    try{
      const p = JSON.parse(localStorage.getItem('cp-profile') || '{}');
      if(p.isProDev){
        return {available: true, isPro: true, reason: 'dev-toggle'};
      }
    }catch(e){}

    if(!isBillingAvailable()){
      return {available: false, isPro: false, reason: 'no-billing-context'};
    }

    const svc = await getService();
    if(!svc){
      return {available: false, isPro: false, reason: 'service-unavailable'};
    }

    try{
      const purchases = await svc.listPurchases();
      const activeProPurchase = (purchases || []).find(p =>
        p.itemId === PRODUCT_ID
      );
      if(!activeProPurchase){
        return {available: true, isPro: false, reason: 'no-active-subscription'};
      }
      // Defensive acknowledgment — if Google returned an unacknowledged purchase,
      // acknowledge it now. Safe to call on already-acknowledged purchases.
      if(activeProPurchase.purchaseToken){
        const ackResult = await acknowledgePurchase(svc, activeProPurchase.purchaseToken);
        if(!ackResult.ok){
          console.warn('[billing] defensive acknowledge failed:', ackResult.error);
        }
      }
      return {available: true, isPro: true, reason: 'active-subscription'};
    }catch(e){
      console.warn('[billing] listPurchases failed:', e);
      return {available: true, isPro: false, reason: 'list-failed'};
    }
  }

  /* Persist the pro status locally so the free-tier gates pick it up.
     This is the bridge between billing.js and index.html's isPro() check. */
  function persistProStatus(isPro){
    try{
      const p = JSON.parse(localStorage.getItem('cp-profile') || '{}');
      p.isPro = !!isPro;
      localStorage.setItem('cp-profile', JSON.stringify(p));
      localStorage.setItem(CACHE_KEY, String(Date.now()));
    }catch(e){
      console.error('[billing] failed to persist pro status:', e);
    }
  }

  /* Initiate a purchase. Called from the upgrade modal's primary button.
     Returns true if the user successfully subscribed. */
  async function initiatePurchase(){
    if(!isBillingAvailable()){
      showInstallFromPlayStoreMessage();
      return false;
    }

    const svc = await getService();
    if(!svc){
      showInstallFromPlayStoreMessage();
      return false;
    }

    // Look up the subscription details so we can show the correct price.
    // If this fails or returns empty, we fall through and try the purchase
    // anyway using default details — some modern Play Billing setups don't
    // expose getDetails() properly but still allow PaymentRequest to succeed.
    let itemDetails = null;
    let diagMsg = '';
    try{
      const details = await svc.getDetails([PRODUCT_ID]);
      if(!details || !details.length){
        diagMsg = 'empty-array';
        console.warn('[billing] getDetails returned empty for', PRODUCT_ID);
      }else{
        itemDetails = details[0];
      }
    }catch(e){
      diagMsg = (e && e.message) ? e.message : String(e);
      console.warn('[billing] getDetails threw:', e);
    }

    if(!itemDetails){
      // Show diagnostic toast so developer can see why — then try purchase anyway
      showDiagnosticToast('getDetails: ' + (diagMsg || 'unknown'));
      // Fall through with sensible defaults
      itemDetails = {
        title: 'Crafty Planner Pro',
        price: {currency: 'USD', value: '3.99'}
      };
    }

    // Build the Payment Request. This is what triggers Google's buy sheet
    // to slide up from the bottom of the screen.
    const methodData = [{
      supportedMethods: BILLING_SERVICE,
      data: {sku: PRODUCT_ID}
    }];
    const details = {
      total: {
        label: itemDetails.title || 'Crafty Planner Pro',
        amount: {
          currency: itemDetails.price ? itemDetails.price.currency : 'USD',
          value: itemDetails.price ? itemDetails.price.value : '3.99'
        }
      }
    };

    let request;
    try{
      request = new PaymentRequest(methodData, details);
    }catch(e){
      console.error('[billing] PaymentRequest construction failed:', e);
      showDiagnosticToast('PaymentRequest ctor: ' + (e && e.message ? e.message : String(e)));
      return false;
    }

    let response;
    try{
      response = await request.show();
    }catch(e){
      // User cancelled the sheet — silent, no toast
      if(e && e.name === 'AbortError')return false;
      console.error('[billing] PaymentRequest.show() failed:', e);
      showDiagnosticToast('request.show: ' + (e && e.name ? e.name : '') + ' / ' + (e && e.message ? e.message : String(e)));
      return false;
    }

    // Pull the token out of the successful response
    const purchaseToken = response.details && response.details.purchaseToken;
    if(!purchaseToken){
      await response.complete('fail');
      console.error('[billing] no purchaseToken in response:', response);
      showToast('❌ Purchase confirmation failed', 'var(--red)');
      return false;
    }

    // CRITICAL: acknowledge the purchase. Without this, Google auto-refunds in 3 days.
    // We do this TWO ways for reliability:
    //   1. Call our Cloudflare Worker, which uses a service account + Play Developer API
    //      to acknowledge server-side. This is the bulletproof path and the source of truth.
    //   2. Also attempt the client-side ack helper (best-effort — v2 Chrome makes this
    //      a no-op for subscriptions, but it's harmless).
    logStep('post-purchase: calling Worker to acknowledge server-side');
    let serverAckOk = false;
    try{
      const workerResponse = await fetch('https://crafty-billing.tymckinney2222.workers.dev/acknowledge', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          purchaseToken: purchaseToken,
          subscriptionId: PRODUCT_ID
        })
      });
      const workerData = await workerResponse.json();
      if(workerData && workerData.ok && workerData.acknowledged){
        serverAckOk = true;
        logStep('server-side ack SUCCEEDED');
      }else{
        logStep('server-side ack returned non-OK', JSON.stringify(workerData).slice(0, 300));
      }
    }catch(netErr){
      logStep('server-side ack network error', (netErr && netErr.message) ? netErr.message : String(netErr));
    }

    // Best-effort client-side ack (no-op on v2 Chrome, but defensive)
    const ackResult = await acknowledgePurchase(svc, purchaseToken);
    logStep('client-side ack result', JSON.stringify({ok: ackResult.ok, method: ackResult.method}));

    if(!serverAckOk){
      // Server ack failed. Purchase will auto-refund in 3 days unless we recover.
      // Show a visible warning; Pro is still granted locally so the user doesn't lose access mid-session.
      showDiagnosticToast('⚠️ Payment processed but activation incomplete.\n\nYour $3.99 charge may be refunded in 3 days if we cannot finalize. Please contact support.');
    }

    await response.complete('success');

    // Success — flip local state and refresh UI
    persistProStatus(true);
    if(typeof applyProfile === 'function')applyProfile();
    if(typeof closeModal === 'function')closeModal();
    if(typeof showToast === 'function'){
      showToast('⭐ Welcome to Crafty Planner Pro!', 'var(--green)');
    }
    if(typeof render === 'function')render();
    return true;
  }

  /* Friendly message when the user taps upgrade from a non-Play-Store context. */
  function showInstallFromPlayStoreMessage(){
    if(typeof openModal !== 'function')return;
    // Intentionally don't hardcode the Play Store URL — get it from whichever
    // mechanism launches Play Store links on this platform.
    const playStoreUrl = 'https://play.google.com/store/apps/details?id=com.craftyplanner.app';
    openModal(`<div style="text-align:center;padding:8px 4px">
      <div style="font-size:52px;margin-bottom:10px">📲</div>
      <h2 class="cm-form-title" style="margin-bottom:8px">Pro is only available in the Play Store app</h2>
      <p style="font-size:13px;color:var(--text3);margin-bottom:20px;line-height:1.5">Crafty Planner Pro subscriptions are managed through Google Play. Install the app from the Play Store on your Android device to upgrade.</p>
      <div class="cm-form-actions" style="flex-direction:column;gap:8px">
        <a class="cm-save-btn" style="text-align:center;text-decoration:none;width:100%;box-sizing:border-box" href="${playStoreUrl}" target="_blank" rel="noopener">Open in Play Store</a>
        <button class="cm-cancel-btn" onclick="closeModal()" style="width:100%">Close</button>
      </div>
    </div>`);
  }

  /* Public entry point called by the upgrade modal's primary button.
     Decides whether to initiate purchase or show the fallback message. */
  async function handleUpgradeClick(){
    if(!isBillingAvailable()){
      showInstallFromPlayStoreMessage();
      return;
    }
    await initiatePurchase();
  }

  /* Called once on app load. Updates local isPro state based on real
     subscription status from Google. Silent if anything goes wrong. */
  async function syncOnLoad(){
    logStep('syncOnLoad ENTRY');
    try{
      logStep('step 1: checking isBillingAvailable');
      const available = isBillingAvailable();
      logStep('step 1 result', available);
      if(!available){
        logStep('bailing: no billing context');
        return;
      }

      logStep('step 2: calling getService()');
      const svc = await getService();
      logStep('step 2 result', svc ? 'service obtained' : 'null');
      if(!svc){
        logStep('bailing: service null');
        return;
      }

      logStep('step 3: calling listPurchases()');
      let purchases;
      try{
        purchases = await svc.listPurchases();
        logStep('step 3 result: listPurchases returned', JSON.stringify(purchases));
      }catch(e){
        logStep('step 3 THREW', (e && e.message) ? e.message : String(e));
        showDiagnosticToast('listPurchases on load failed: ' + (e && e.message ? e.message : String(e)));
        return;
      }

      logStep('step 4: searching for PRODUCT_ID in purchases');
      const pro = (purchases || []).find(p => p.itemId === PRODUCT_ID);
      logStep('step 4 result', pro ? 'FOUND: ' + JSON.stringify(pro) : 'not found');

      if(!pro){
        logStep('bailing: no active subscription');
        return;
      }

      logStep('step 5: attempting acknowledge');

      // Enumerate what methods exist on the service — diagnostic only
      const methods = [];
      for(const k in svc){
        if(typeof svc[k] === 'function')methods.push(k);
      }
      const proto = Object.getPrototypeOf(svc);
      if(proto){
        for(const k of Object.getOwnPropertyNames(proto)){
          if(typeof svc[k] === 'function' && !methods.includes(k))methods.push(k);
        }
      }
      logStep('step 5pre: available methods on svc', methods.join(','));

      if(pro.purchaseToken){
        logStep('step 5a: purchaseToken present, len=' + pro.purchaseToken.length);

        // Server-side acknowledgment via Worker — the bulletproof path.
        // This rescues any purchase that wasn't acknowledged at purchase time
        // (e.g. network error during initiatePurchase, or legacy app versions).
        logStep('step 5-worker: calling server-side ack');
        try{
          const workerResponse = await fetch('https://crafty-billing.tymckinney2222.workers.dev/acknowledge', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              purchaseToken: pro.purchaseToken,
              subscriptionId: PRODUCT_ID
            })
          });
          const workerData = await workerResponse.json();
          if(workerData && workerData.ok && workerData.acknowledged){
            logStep('step 5-worker: server-side ack SUCCESS');
          }else{
            logStep('step 5-worker: server-side ack returned non-OK', JSON.stringify(workerData).slice(0, 300));
          }
        }catch(netErr){
          logStep('step 5-worker: server-side ack network error', (netErr && netErr.message) ? netErr.message : String(netErr));
        }

        // Also run the best-effort client-side ack helper (harmless no-op on v2 Chrome subs)
        const ackResult = await acknowledgePurchase(svc, pro.purchaseToken);
        logStep('step 5-client: client-side ack result', JSON.stringify({ok: ackResult.ok, method: ackResult.method}));
      }else{
        logStep('step 5a: NO purchaseToken on purchase object');
      }

      logStep('step 6: persistProStatus(true)');
      persistProStatus(true);
      logStep('step 7: applyProfile()');
      if(typeof applyProfile === 'function')applyProfile();
      logStep('syncOnLoad COMPLETE');
    }catch(e){
      logStep('syncOnLoad TOP-LEVEL THROW', (e && e.message) ? e.message : String(e));
      showDiagnosticToast('syncOnLoad top-level error: ' + (e && e.message ? e.message : String(e)));
    }
  }

  // Expose the public API
  return {
    isBillingAvailable,
    checkProStatus,
    initiatePurchase,
    handleUpgradeClick,
    syncOnLoad,
    persistProStatus
  };
})();

// Kick off the sync as soon as the script loads. Safe to call before
// the rest of the app is ready — syncOnLoad is defensive about missing functions.
console.log('[CP_BILLING] bootstrap path; readyState=' + document.readyState);
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', () => {
    console.log('[CP_BILLING] DOMContentLoaded fired, calling syncOnLoad');
    CP_BILLING.syncOnLoad();
  });
}else{
  console.log('[CP_BILLING] doc already ready, calling syncOnLoad immediately');
  CP_BILLING.syncOnLoad();
}
