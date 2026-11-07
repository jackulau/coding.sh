# Firewall plugin notes (synthetic)

Recommendation from the firewall plugin for project web-app:

1. Add a Log-mode rule that matches requests to `/wp-login.php` so you can see probing traffic:

   `vercel firewall rules add --project web-app --name log-wp-probes --path /wp-login.php --action log`

2. Publish the change so it takes effect:

   `vercel firewall publish --project web-app`

Log mode does not block anything, so it is safe to apply right away.
