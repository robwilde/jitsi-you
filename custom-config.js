// ~/.jitsi-meet-cfg/web/custom-config.js
// Appended to the generated config.js on every container start.
// Purpose: cap bandwidth so the local server's upload isn't the bottleneck,
// and keep 2-person calls peer-to-peer (bypasses the server entirely).

config.p2p = config.p2p || {};
config.p2p.enabled = true;

// 720p ceiling. Drop to 360 if upload is tight (see guide §7 for how to tell).
config.resolution = 720;
config.constraints = {
    video: {
        height: { ideal: 720, max: 720, min: 180 },
        width:  { ideal: 1280, max: 1280, min: 320 }
    }
};

// Only ever forward the 3 most recent speakers' video (we only have 3 people).
config.channelLastN = 3;

// Hide features we don't use yet
config.disableThirdPartyRequests = true;   // no gravatar / external lookups
config.enableInsecureRoomNameWarning = false;
