/**
 * The Google sign-in details that ship with the system, so a shop does not have to make its own Google Cloud project.
 *
 * Whoever supplies the system makes ONE OAuth client (type "TVs and Limited Input devices", scope drive.file, consent
 * screen published "In production") and puts its two values here. Every shop then only has to press "Add a Google
 * account" and enter a code, the same as signing in with Google anywhere else.
 *
 * Google treats this client type as one that cannot keep a secret (it runs on devices people own), so these two values
 * are not a password and may sit in the source. They only say which app is asking. They give no access to anyone's Drive:
 * each account still has to approve the app on google.com/device, and the app sees only the files it made itself.
 *
 * Left as null, a shop sets up its own client instead (see docs/runbook.md). The server settings GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET, or values saved from the screen, win over these.
 */
export const BUNDLED_GOOGLE_CLIENT: { clientId: string; clientSecret: string } | null = null;
