// ~/.jitsi-meet-cfg/web/custom-config.js
// Appended verbatim to the container-generated config.js on every `web` start
// (the image's config script does: cat custom-config.js >> config.js).
// Reload after editing: docker compose restart web  (no need for down/up).
//
// This file holds ONLY keys that have no .env equivalent. Resolution, capture
// constraints and P2P are set from jitsi.env (RESOLUTION*, ENABLE_P2P) so there
// is one source of truth and one reload rule per setting — see guide §7.

// Only ever forward the 3 most recent speakers' video (we only have 3 people).
// No env equivalent.
config.channelLastN = 3;

// Hide features we don't use yet. No env equivalents.
config.disableThirdPartyRequests = true;   // no gravatar / external lookups
config.enableInsecureRoomNameWarning = false;
