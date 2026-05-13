"use strict";

const fs      = require("fs");
const path    = require("path");
const bcrypt  = require("bcryptjs");
const crypto  = require("crypto");

const USERS_FILE  = path.join(__dirname, "../data/users.json");
const DATA_USERS  = path.join(__dirname, "../data/users");
const ADMIN_EMAIL = "kenzohaizen@gmail.com";
const ADMIN_PASS  = "cozy24123";
const ADMIN_ID    = "admin_001";

const sessions = new Map(); // token -> sessionObj

function readUsers() {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); }
    catch (_) { return []; }
}
function writeUsers(arr) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(arr, null, 2), "utf8");
}

function init() {
    try { fs.mkdirSync(DATA_USERS, { recursive: true }); } catch (_) {}
    const users = readUsers();
    if (!users.find(u => u.email.toLowerCase() === ADMIN_EMAIL.toLowerCase())) {
        users.push({
            id:           ADMIN_ID,
            username:     "Admin",
            email:        ADMIN_EMAIL,
            passwordHash: bcrypt.hashSync(ADMIN_PASS, 10),
            isAdmin:      true,
            isBanned:     false,
            banReason:    "",
            createdAt:    new Date().toISOString(),
            lastSeen:     null,
            sessionStart: null,
        });
        writeUsers(users);
    }
}

function register(username, email, password) {
    if (!username || !email || !password) return { error: "All fields required" };
    if (password.length < 6) return { error: "Password must be at least 6 characters" };
    const users = readUsers();
    if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
        return { error: "Email already registered" };
    const id   = "user_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex");
    const user = {
        id, username, email,
        passwordHash: bcrypt.hashSync(password, 10),
        isAdmin:      email.toLowerCase() === ADMIN_EMAIL.toLowerCase(),
        isBanned:     false,
        banReason:    "",
        createdAt:    new Date().toISOString(),
        lastSeen:     null,
        sessionStart: null,
    };
    users.push(user);
    writeUsers(users);
    return { user };
}

function login(email, password) {
    if (!email || !password) return { error: "Email and password required" };
    const users = readUsers();
    const user  = users.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (!user) return { error: "Invalid email or password" };
    if (user.isBanned) return { error: "Account banned" + (user.banReason ? ": " + user.banReason : "") };
    if (!bcrypt.compareSync(password, user.passwordHash)) return { error: "Invalid email or password" };
    return { user };
}

function createSession(user) {
    const token = crypto.randomBytes(40).toString("hex");
    const sess  = {
        token,
        userId:   user.id,
        username: user.username,
        email:    user.email,
        isAdmin:  !!user.isAdmin,
        createdAt: Date.now(),
    };
    sessions.set(token, sess);

    const users = readUsers();
    const u     = users.find(x => x.id === user.id);
    if (u) {
        u.lastSeen     = new Date().toISOString();
        u.sessionStart = new Date().toISOString();
        writeUsers(users);
    }
    return token;
}

function getSession(token) {
    if (!token) return null;
    return sessions.get(token) || null;
}

function destroySession(token) {
    sessions.delete(token);
    const users = readUsers();
    const u = users.find(x => {
        const s = sessions.get(token);
        return s && x.id === s.userId;
    });
    if (u) { u.sessionStart = null; writeUsers(users); }
}

function getSessionFromReq(req) {
    const raw = req.headers.cookie || "";
    const match = raw.match(/(?:^|;\s*)dbl_sess=([^;]+)/);
    return match ? getSession(match[1]) : null;
}

function getAllUsers() { return readUsers(); }

function getUser(id) {
    return readUsers().find(u => u.id === id) || null;
}

function banUser(id, reason) {
    const users = readUsers();
    const u     = users.find(x => x.id === id);
    if (u) { u.isBanned = true; u.banReason = reason || ""; writeUsers(users); }
}

function unbanUser(id) {
    const users = readUsers();
    const u     = users.find(x => x.id === id);
    if (u) { u.isBanned = false; u.banReason = ""; writeUsers(users); }
}

function deleteUser(id) {
    const users = readUsers().filter(u => u.id !== id);
    writeUsers(users);
    for (const [tok, s] of sessions.entries()) {
        if (s.userId === id) sessions.delete(tok);
    }
}

function getActiveSessions() {
    return Array.from(sessions.values());
}

function updateLastSeen(userId) {
    const users = readUsers();
    const u     = users.find(x => x.id === userId);
    if (u) { u.lastSeen = new Date().toISOString(); writeUsers(users); }
}

module.exports = {
    init, register, login,
    createSession, getSession, getSessionFromReq, destroySession,
    getAllUsers, getUser, banUser, unbanUser, deleteUser,
    getActiveSessions, updateLastSeen, ADMIN_EMAIL,
};
