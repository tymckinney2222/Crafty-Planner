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

  /* Version-aware acknowledgment.
     Digital Goods API v2 (current Chrome/TWA): uses svc.consume(token)
     Digital Goods API v1 (deprecated): used svc.acknowledge(token, type)
     Tries v2 first, falls back to v1. Returns {ok, method, error}. */
  async function acknowledgePurchase(svc, purchaseToken){
    if(!purchaseToken)return {ok: false, method: null, error: 'no token'};
    // Prefer v2: consume()
    if(typeof svc.consume === 'function'){
      try{
        await svc.consume(purchaseToken);
        return {ok: true, method: 'consume', error: null};
      }catch(e){
        // Fall through to legacy fallback if consume fails
        logStep('consume() failed, trying legacy acknowledge', (e && e.message) ? e.message : String(e));
      }
    }
    // Legacy v1: acknowledge(token, type)
    if(typeof svc.acknowledge === 'function'){
      for(const flavor of ['onetime', 'repeatable']){
        try{
          await svc.acknowledge(purchaseToken, flavor);
          return {ok: true, method: 'acknowledge-' + flavor, error: null};
        }catch(e){
          // try next flavor
        }
      }
      return {ok: false, method: null, error: 'acknowledge(' + purchaseToken.slice(0,8) + '...) rejected by all flavors'};
    }
    return {ok: false, method: null, error: 'no acknowledge/consume method exists on service'};
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

    // CRITICAL: acknowledge the purchase within 3 days or Google auto-refunds.
    // Uses version-aware helper: tries v2 consume() first, falls back to v1 acknowledge().
    const ackResult = await acknowledgePurchase(svc, purchaseToken);
    if(!ackResult.ok){
      console.error('[billing] acknowledgment FAILED:', ackResult.error);
      showDiagnosticToast('ACK FAILED: ' + ackResult.error + '\n\nYour purchase went through but was NOT acknowledged. Google will auto-refund in 3 days.');
      await response.complete('fail');
      return false;
    }
    logStep('post-purchase ack succeeded via ' + ackResult.method);

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
      let ackSucceeded = false;
      let lastErr = null;

      // Enumerate what methods actually exist on the service so we know
      // which API version we're dealing with.
      const methods = [];
      for(const k in svc){
        if(typeof svc[k] === 'function')methods.push(k);
      }
      // Also check inherited methods via prototype chain
      const proto = Object.getPrototypeOf(svc);
      if(proto){
        for(const k of Object.getOwnPropertyNames(proto)){
          if(typeof svc[k] === 'function' && !methods.includes(k))methods.push(k);
        }
      }
      logStep('step 5pre: available methods on svc', methods.join(','));

      if(pro.purchaseToken){
        logStep('step 5a: purchaseToken present, len=' + pro.purchaseToken.length);

        // Digital Goods API v2 (current Chrome) uses consume() — no acknowledge()
        // v1 (deprecated) used acknowledge(token, type).
        // Try the modern consume() first, then fall back to legacy acknowledge().
        const attempts = [
          {name: 'consume',            fn: () => svc.consume && svc.consume(pro.purchaseToken)},
          {name: 'acknowledge-onetime',fn: () => svc.acknowledge && svc.acknowledge(pro.purchaseToken, 'onetime')},
          {name: 'acknowledge-repeat', fn: () => svc.acknowledge && svc.acknowledge(pro.purchaseToken, 'repeatable')}
        ];

        for(const attempt of attempts){
          logStep('step 5b: trying ' + attempt.name);
          try{
            const result = attempt.fn();
            if(result === undefined){
              logStep('step 5c: ' + attempt.name + ' method does not exist, skipping');
              continue;
            }
            await result;
            ackSucceeded = true;
            logStep('step 5c: SUCCESS with ' + attempt.name);
            showDiagnosticToast('✅ Purchase acknowledged via ' + attempt.name);
            break;
          }catch(e){
            lastErr = e;
            logStep('step 5c: ' + attempt.name + ' FAILED', (e && e.message) ? e.message : String(e));
          }
        }
      }else{
        logStep('step 5a: NO purchaseToken on purchase object');
      }

      if(!ackSucceeded && lastErr){
        logStep('all ack methods failed');
        showDiagnosticToast('All ack methods failed. Last: ' +
          (lastErr && lastErr.message ? lastErr.message : String(lastErr)));
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
