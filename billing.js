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
      // IMPORTANT: Digital Goods API uses 'onetime' for subscriptions
      // (counterintuitive — Google renews the ack automatically on each billing period).
      try{
        if(activeProPurchase.purchaseToken){
          await svc.acknowledge(activeProPurchase.purchaseToken, 'onetime');
        }
      }catch(ackErr){
        console.warn('[billing] defensive acknowledge failed:', ackErr);
        showDiagnosticToast('defensive ack: ' + (ackErr && ackErr.message ? ackErr.message : String(ackErr)));
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
    // The Digital Goods API uses 'onetime' for subscriptions — the subscription
    // itself is acknowledged once; Google re-acknowledges automatically on each
    // renewal. 'repeatable' is only for consumable one-time purchases.
    try{
      await svc.acknowledge(purchaseToken, 'onetime');
    }catch(ackErr){
      // Show the real error so we can see what happened
      const msg = (ackErr && ackErr.message) ? ackErr.message : String(ackErr);
      console.error('[billing] acknowledgment FAILED:', ackErr);
      showDiagnosticToast('ACK FAILED: ' + msg + '\n\nYour purchase went through but was NOT acknowledged. Google will auto-refund in 3 days. Please tell the developer this error message.');
      await response.complete('fail');
      return false;
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
    try{
      // ALWAYS query listPurchases on load — we need to catch any unacknowledged
      // purchases (Google gives us 3 days to acknowledge or it auto-refunds).
      // The 24h cache was too aggressive and hid failed acknowledgments.
      if(!isBillingAvailable()){
        return; // no billing context, nothing to sync
      }

      const svc = await getService();
      if(!svc){
        return;
      }

      let purchases;
      try{
        purchases = await svc.listPurchases();
      }catch(e){
        showDiagnosticToast('listPurchases on load failed: ' + (e && e.message ? e.message : String(e)));
        return;
      }

      const pro = (purchases || []).find(p => p.itemId === PRODUCT_ID);

      if(!pro){
        // No active subscription. Don't flip local flag to false automatically
        // (respects dev toggle). Just bail.
        return;
      }

      // Found an active subscription. Aggressively try to acknowledge it —
      // using BOTH 'onetime' and 'repeatable' as fallbacks, since different
      // Play Billing configs disagree about which is correct for subs.
      let ackSucceeded = false;
      let lastErr = null;

      if(pro.purchaseToken){
        for(const flavor of ['onetime', 'repeatable']){
          try{
            await svc.acknowledge(pro.purchaseToken, flavor);
            ackSucceeded = true;
            showDiagnosticToast('✅ Purchase acknowledged (' + flavor + ')');
            break;
          }catch(e){
            lastErr = e;
            console.warn('[billing] ack with ' + flavor + ' failed:', e);
          }
        }
      }

      if(!ackSucceeded && lastErr){
        showDiagnosticToast('Both ack flavors failed. Last error: ' +
          (lastErr && lastErr.message ? lastErr.message : String(lastErr)) +
          '\n\npurchaseToken present: ' + !!pro.purchaseToken +
          '\nitemId: ' + pro.itemId);
      }

      // Regardless of ack result, flip local state to Pro — the subscription
      // EXISTS in Google's records; ack just determines whether it stays.
      persistProStatus(true);
      if(typeof applyProfile === 'function')applyProfile();
    }catch(e){
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
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', () => CP_BILLING.syncOnLoad());
}else{
  CP_BILLING.syncOnLoad();
}
