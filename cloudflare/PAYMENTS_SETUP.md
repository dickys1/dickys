# Secure card checkout setup

The storefront remains on GitHub Pages. Card details are entered only on
Pesapal's hosted checkout; this Cloudflare Worker creates orders and verifies
their status without receiving or storing card numbers.

## One-time setup

1. In the `dickys1/dickys` GitHub repository, add the `CLOUDFLARE_ACCOUNT_ID`
   and `CLOUDFLARE_API_TOKEN` repository Actions secrets. The API token needs
   permission to edit and deploy Workers.
2. Run **Actions → Deploy Pesapal checkout → Run workflow**. The deployed
   Worker URL appears in the workflow log and Cloudflare dashboard.
3. In the Cloudflare dashboard, open the `dickys-pesapal-checkout` Worker and
   add these **secrets** under Settings → Variables and Secrets:
   `PESAPAL_CONSUMER_KEY` and `PESAPAL_CONSUMER_SECRET`. Use sandbox
   credentials for testing; never put credentials in website code or GitHub
   commits.
4. In `payment-config.js`, set `window.DICKYS_PESAPAL_CHECKOUT_URL` to the
   deployed HTTPS Worker URL and publish the change. The storefront checks the
   Worker before enabling cards; sandbox mode and missing or invalid live
   credentials keep card checkout disabled.
5. Test a complete sandbox payment. For live payments, obtain production
   credentials from Pesapal, switch `PESAPAL_ENV` in `cloudflare/wrangler.toml`
   to `live`, add the production secrets in Cloudflare, and deploy again.
   The card option becomes available only after the live Worker successfully
   authenticates with Pesapal. A completed sandbox flow is not proof that live
   card processing is ready.

Online card checkout is limited to Nairobi while nationwide delivery charges
are confirmed separately, and customers continue on Pesapal's secure hosted
payment page to enter card details. Other payment choices continue through
WhatsApp. The Worker registers its Pesapal IPN endpoint automatically and
checks the transaction status directly with Pesapal before displaying a
successful payment confirmation. Never collect card details on GitHub Pages
or store them in the Worker.
