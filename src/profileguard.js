"use strict";

const fs = require("fs");

function buildCookieString(fbstatePath) {
    try {
        const state = JSON.parse(fs.readFileSync(fbstatePath, "utf8"));
        if (!Array.isArray(state)) return "";
        return state.map(c => `${c.key}=${c.value}`).join("; ");
    } catch (_) { return ""; }
}

function getUserIdFromCookie(cookieStr) {
    const match = /c_user=(\d+)/.exec(cookieStr);
    return match ? match[1] : null;
}

function fcaHttpGet(api, url) {
    return new Promise((resolve, reject) => {
        api.httpGet(url, {}, (err, body) => err ? reject(err) : resolve(body), true);
    });
}

function fcaHttpPost(api, url, form) {
    return new Promise((resolve, reject) => {
        api.httpPost(url, form, (err, body) => err ? reject(err) : resolve(body));
    });
}

async function getFbDtsg(api) {
    const html = String(await fcaHttpGet(api, "https://www.facebook.com/"));
    let match = /"fb_dtsg"\s*:\s*\{"value"\s*:\s*"([^"]+)"/.exec(html);
    if (!match) match = /"fb_dtsg"\s*:\s*"([^"]+)"/.exec(html);
    if (!match) match = /name="fb_dtsg"\s+value="([^"]+)"/.exec(html);
    return match ? match[1] : null;
}

async function toggleProfileGuard(fbstatePath, enable, api) {
    if (!api || typeof api.httpGet !== "function" || typeof api.httpPost !== "function") {
        throw new Error("fca-unofficial API client is required for profile guard.");
    }

    const cookieStr = buildCookieString(fbstatePath);
    if (!cookieStr) throw new Error("Could not read fbstate cookies.");

    const userId = getUserIdFromCookie(cookieStr);
    if (!userId) throw new Error("Could not extract user ID from cookies.");

    const fbDtsg = await getFbDtsg(api);
    if (!fbDtsg) throw new Error("Could not fetch fb_dtsg token.");

    const form = {
        __a: "1",
        __comet_req: "1",
        doc_id: "7369367446407795",
        variables: JSON.stringify({ input: { is_shielded: enable, actor_id: userId } }),
        av: userId,
        __user: userId,
        fb_dtsg: fbDtsg,
        fb_api_req_friendly_name: "IsShieldedSetMutation",
    };

    const text = String(await fcaHttpPost(
        api,
        "https://www.facebook.com/api/graphql/",
        form
    )).replace(/^for\s*\(;;\);/, "");
    const parsed = JSON.parse(text);
    if (parsed.errors && parsed.errors.length) {
        throw new Error(parsed.errors[0].message || "GraphQL error");
    }
    return { success: true, userId };
}

module.exports = { toggleProfileGuard };