const https = require("https");
const fs    = require("fs");
const path  = require("path");

const OWNER  = "kurtxenthia-ship-it";
const REPO   = "cozybot";
const BRANCH = "main";
const TOKEN  = process.env.GITHUB_TOKEN;

function ghRequest(method, endpoint, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const opts = {
            hostname: "api.github.com",
            path:     `/repos/${OWNER}/${REPO}${endpoint}`,
            method,
            headers: {
                "Authorization": `Bearer ${TOKEN}`,
                "User-Agent":    "dummyl-push",
                "Accept":        "application/vnd.github+json",
                "Content-Type":  "application/json",
                ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
            },
        };
        const req = https.request(opts, res => {
            let raw = "";
            res.on("data", c => raw += c);
            res.on("end", () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
                catch(_) { resolve({ status: res.statusCode, body: raw }); }
            });
        });
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
    });
}

function walkDir(dir, base) {
    let files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel  = path.join(base, entry.name);
        if (entry.isDirectory()) {
            if (["node_modules", ".git", ".local", "attached_assets"].includes(entry.name)) continue;
            files = files.concat(walkDir(full, rel));
        } else {
            files.push({ full, rel });
        }
    }
    return files;
}

async function main() {
    const root = path.join(__dirname, "..");

    console.log("Fetching current HEAD...");
    const refRes = await ghRequest("GET", `/git/ref/heads/${BRANCH}`);
    if (refRes.status !== 200) { console.error("Failed to get ref:", refRes.body); process.exit(1); }
    const baseTree = refRes.body.object.sha;
    console.log("Base commit:", baseTree);

    const getRes = await ghRequest("GET", `/git/commits/${baseTree}`);
    const baseTreeSha = getRes.body.tree.sha;

    const files = walkDir(root, "");
    console.log(`Creating ${files.length} blobs...`);

    const treeItems = [];
    for (const f of files) {
        const content = fs.readFileSync(f.full);
        const blobRes = await ghRequest("POST", "/git/blobs", {
            content:  content.toString("base64"),
            encoding: "base64",
        });
        if (blobRes.status !== 201) { console.error("Blob failed:", f.rel, blobRes.body); continue; }
        treeItems.push({ path: f.rel.replace(/\\/g, "/"), mode: "100644", type: "blob", sha: blobRes.body.sha });
    }

    console.log("Creating tree...");
    const treeRes = await ghRequest("POST", "/git/trees", { base_tree: baseTreeSha, tree: treeItems });
    if (treeRes.status !== 201) { console.error("Tree failed:", treeRes.body); process.exit(1); }

    console.log("Creating commit...");
    const commitRes = await ghRequest("POST", "/git/commits", {
        message: "fix: 1secmail, real FB profile guard, ytdl !p, clean !help",
        tree:    treeRes.body.sha,
        parents: [baseTree],
    });
    if (commitRes.status !== 201) { console.error("Commit failed:", commitRes.body); process.exit(1); }

    console.log("Updating ref...");
    const patchRes = await ghRequest("PATCH", `/git/refs/heads/${BRANCH}`, { sha: commitRes.body.sha, force: false });
    if (patchRes.status !== 200) { console.error("Ref update failed:", patchRes.body); process.exit(1); }

    console.log("Done! Pushed to", BRANCH, "—", commitRes.body.sha);
}

main().catch(e => { console.error(e); process.exit(1); });
