require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const connectedUsers = new Map();
const typingUsers = new Map();

const groupSchema = new mongoose.Schema(
    {
        _id: { type: String },
        name: { type: String, required: true, trim: true },
        nameKey: { type: String, required: true, unique: true },
        createdBy: { type: String, required: true },
        members: { type: [String], default: [] }
    },
    { timestamps: true }
);

const messageSchema = new mongoose.Schema(
    {
        groupId: { type: String, required: true, index: true },
        username: { type: String, required: true },
        message: { type: String, required: true, maxlength: 500 },
        senderId: { type: String, required: true }
    },
    { timestamps: true }
);

const Group = mongoose.model("Group", groupSchema);
const Message = mongoose.model("Message", messageSchema);

app.use(express.static(__dirname));

app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok" });
});

function getGroupData(group) {
    return {
        id: group._id,
        name: group.name,
        memberCount: group.members.length
    };
}

async function sendGroupsUpdate() {
    const groups = await Group.find().sort({ name: 1 }).lean();
    io.emit("groups update", groups.map(getGroupData));
}

async function sendMyGroups(socket, userId) {
    const groups = await Group.find({ members: userId }).sort({ name: 1 }).lean();
    socket.emit("my groups", groups.map(getGroupData));
}

function sendOnlineCount() {
    io.emit("online users", connectedUsers.size);
}

function sendTypingUsers(groupId) {
    const users = typingUsers.get(groupId);
    io.to(groupId).emit("typing users", {
        groupId,
        users: users ? Array.from(users.values()) : []
    });
}

function removeTypingUser(socket, groupId) {
    const users = typingUsers.get(groupId);

    if (users) {
        users.delete(socket.id);
        if (users.size === 0) typingUsers.delete(groupId);
    }

    sendTypingUsers(groupId);
}

function handleError(socket, error, publicMessage = "Something went wrong. Please try again.") {
    console.error(error);
    socket.emit("app error", publicMessage);
}

io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);

    socket.on("join chat", async (payload) => {
        try {
            if (connectedUsers.has(socket.id)) return;

            if (!payload || typeof payload.username !== "string" ||
                typeof payload.userId !== "string") {
                socket.emit("app error", "Please enter a valid username.");
                return;
            }

            const username = payload.username.trim().slice(0, 20);
            const userId = payload.userId.trim().slice(0, 80);

            if (!username || !/^[a-zA-Z0-9_-]{10,80}$/.test(userId)) {
                socket.emit("app error", "Please enter a valid username.");
                return;
            }

            connectedUsers.set(socket.id, { username, userId });

            // Rejoin this browser's saved groups after a refresh or reconnect.
            const savedGroups = await Group.find({ members: userId }).lean();
            for (const group of savedGroups) {
                socket.join(group._id);
            }

            socket.emit("join success", username);
            socket.broadcast.emit("user notification", `${username} joined the chat.`);

            sendOnlineCount();
            await sendMyGroups(socket, userId);
            await sendGroupsUpdate();
        } catch (error) {
            handleError(socket, error, "Could not connect to the chat. Please try again.");
        }
    });

    socket.on("create group", async (groupName) => {
        try {
            const user = connectedUsers.get(socket.id);
            if (!user || typeof groupName !== "string") return;

            groupName = groupName.trim().slice(0, 30);
            if (!groupName) {
                socket.emit("app error", "Please enter a group name.");
                return;
            }

            const groupId = require("crypto").randomUUID();

            let group;
            try {
                group = await Group.create({
                    _id: groupId,
                    name: groupName,
                    nameKey: groupName.toLowerCase(),
                    createdBy: user.userId,
                    members: [user.userId]
                });
            } catch (error) {
                if (error.code === 11000) {
                    socket.emit("app error", "A group with this name already exists.");
                    return;
                }
                throw error;
            }

            socket.join(group._id);
            socket.emit("group joined", getGroupData(group));

            await sendMyGroups(socket, user.userId);
            await sendGroupsUpdate();

            io.to(group._id).emit(
                "group notification",
                `${user.username} created this group.`
            );

            console.log(`${user.username} created group: ${group.name}`);
        } catch (error) {
            handleError(socket, error);
        }
    });

    socket.on("join group", async (groupId) => {
        try {
            const user = connectedUsers.get(socket.id);
            if (!user || typeof groupId !== "string") return;

            const group = await Group.findById(groupId);
            if (!group) {
                socket.emit("app error", "This group is no longer available.");
                return;
            }

            if (!group.members.includes(user.userId)) {
                group.members.push(user.userId);
                await group.save();
            }

            socket.join(group._id);
            socket.emit("group joined", getGroupData(group));

            socket.to(group._id).emit(
                "group notification",
                `${user.username} joined this group.`
            );

            await sendMyGroups(socket, user.userId);
            await sendGroupsUpdate();
        } catch (error) {
            handleError(socket, error);
        }
    });

    socket.on("leave group", async (groupId) => {
        try {
            const user = connectedUsers.get(socket.id);
            if (!user || typeof groupId !== "string") return;

            const group = await Group.findById(groupId);
            if (!group || !group.members.includes(user.userId)) return;

            group.members = group.members.filter(id => id !== user.userId);
            await group.save();

            socket.leave(groupId);
            removeTypingUser(socket, groupId);

            socket.emit("group left", groupId);

            io.to(groupId).emit(
                "group notification",
                `${user.username} left this group.`
            );

            await sendMyGroups(socket, user.userId);
            await sendGroupsUpdate();
        } catch (error) {
            handleError(socket, error);
        }
    });

    socket.on("get group history", async (groupId) => {
        try {
            const user = connectedUsers.get(socket.id);
            if (!user || typeof groupId !== "string") return;

            const group = await Group.findById(groupId).lean();
            if (!group || !group.members.includes(user.userId)) return;

            const savedMessages = await Message.find({ groupId })
                .sort({ createdAt: -1 })
                .limit(100)
                .lean();

            const messages = savedMessages.reverse().map(item => ({
                groupId: item.groupId,
                username: item.username,
                message: item.message,
                senderId: item.senderId,
                time: item.createdAt.toISOString()
            }));

            socket.emit("group history", { groupId, messages });
        } catch (error) {
            handleError(socket, error, "Could not load message history.");
        }
    });

    socket.on("group message", async (data) => {
        try {
            const user = connectedUsers.get(socket.id);
            if (!user || !data || typeof data.groupId !== "string" ||
                typeof data.message !== "string") return;

            const group = await Group.findById(data.groupId).lean();
            if (!group || !group.members.includes(user.userId)) return;

            const message = data.message.trim().slice(0, 500);
            if (!message) return;

            const savedMessage = await Message.create({
                groupId: group._id,
                username: user.username,
                message,
                senderId: user.userId
            });

            io.to(group._id).emit("group message", {
                groupId: group._id,
                username: user.username,
                message,
                senderId: user.userId,
                time: savedMessage.createdAt.toISOString()
            });
        } catch (error) {
            handleError(socket, error, "Message could not be sent. Please try again.");
        }
    });

    socket.on("typing", (groupId) => {
        const user = connectedUsers.get(socket.id);
        if (!user || typeof groupId !== "string") return;

        if (!typingUsers.has(groupId)) typingUsers.set(groupId, new Map());
        typingUsers.get(groupId).set(socket.id, user.username);
        sendTypingUsers(groupId);
    });

    socket.on("stop typing", (groupId) => {
        if (typeof groupId === "string") removeTypingUser(socket, groupId);
    });

    socket.on("disconnect", () => {
        const user = connectedUsers.get(socket.id);

        if (user) {
            console.log(`${user.username} disconnected.`);
            connectedUsers.delete(socket.id);

            for (const [groupId, users] of typingUsers) {
                if (users.has(socket.id)) removeTypingUser(socket, groupId);
            }

            io.emit("user notification", `${user.username} left the chat.`);
            sendOnlineCount();
        }
    });
});

async function startServer() {
    if (!process.env.MONGODB_URI) {
        console.error("MONGODB_URI is missing. Add it to your .env file.");
        process.exit(1);
    }

    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("Connected to MongoDB.");

        server.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    } catch (error) {
        console.error("Could not connect to MongoDB:", error.message);
        process.exit(1);
    }
}

startServer();
