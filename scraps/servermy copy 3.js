const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const mysql = require('mysql2');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const io = new Server(server, { maxHttpBufferSize: 1e8 });
app.use(express.json());

// JWT secret key
const JWT_SECRET = "7877618775";

// Ensure upload folder exists
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR);
}
app.use(express.static(path.join(__dirname, 'public/sounds/')));

// MySQL setup
const db = mysql.createPool({
    host: '192.168.200.39',
    user: 'emri',
    password: 'emri',
    database: 'chat_app'
});

// Create tables if not exist
db.query(`
    CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) UNIQUE,
        password VARCHAR(255),
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
`);
db.query(`
    CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender VARCHAR(255),
        recipient VARCHAR(255),
        message TEXT,
        filename VARCHAR(255),
        filepath TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`);

db.query(`
    CREATE TABLE IF NOT EXISTS groups (
        id INT AUTO_INCREMENT PRIMARY KEY,
        group_id VARCHAR(255) UNIQUE,
        group_name VARCHAR(255),
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`);

db.query(`
    CREATE TABLE IF NOT EXISTS group_members (
        id INT AUTO_INCREMENT PRIMARY KEY,
        group_id VARCHAR(255),
        username VARCHAR(255),
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_member (group_id, username),
        FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE
    )
`);

db.query(`
    CREATE TABLE IF NOT EXISTS group_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        group_id VARCHAR(255),
        sender VARCHAR(255),
        message TEXT,
        filename VARCHAR(255),
        filepath TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_forwarded BOOLEAN DEFAULT FALSE,
        original_sender VARCHAR(255),
        original_timestamp TIMESTAMP,
        FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE
    )
`);

// ------------------ HELPER FUNCTIONS ------------------

function validateFileUpload(data) {
    const MAX_FILE_SIZE = 100 * 1024 * 1024; // 10MB
    const ALLOWED_TYPES = [
        'image/jpeg', 'image/png', 'image/gif', 'image/webp',
        'application/pdf', 'application/msword', 
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain', 'application/zip'
    ];
    
    if (data.fileSize > MAX_FILE_SIZE) {
        return { valid: false, error: 'File size exceeds 10MB limit' };
    }
    
    if (data.fileType && !ALLOWED_TYPES.includes(data.fileType)) {
        return { valid: false, error: 'File type not allowed' };
    }
    
    return { valid: true };
}

function broadcastGroupUpdate(groupId, event, data) {
    db.query(`SELECT username FROM group_members WHERE group_id = ?`, 
        [groupId], (err, members) => {
            if (err) return;
            
            members.forEach(member => {
                const memberSocket = Array.from(io.sockets.sockets.values())
                    .find(s => s.username === member.username);
                if (memberSocket) {
                    memberSocket.emit(event, { groupId: groupId, ...data });
                }
            });
        });
}

// ------------------ AUTH ROUTES ------------------

// Register
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    db.query(`INSERT INTO users (username, password) VALUES (?, ?)`,
        [username, hashed],
        (err) => {
            if (err) return res.status(400).json({ error: "Username taken" });
            res.json({ message: "User registered" });
        });
});

// Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.query(`SELECT * FROM users WHERE username = ?`, [username], async (err, results) => {
        if (err || results.length === 0) return res.status(400).json({ error: "Invalid credentials" });

        const user = results[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(400).json({ error: "Invalid credentials" });

        const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '24h' });

        // Update last_seen timestamp
        db.query(`UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE username = ?`, [username]);

        res.json({ token, username: user.username });
    });
});

// Get all users (for showing online/offline status)
app.get('/api/users', verifyToken, (req, res) => {
    db.query(`SELECT username, last_seen FROM users WHERE username != ? ORDER BY username`, 
        [req.user.username], 
        (err, results) => {
            if (err) return res.status(500).json({ error: "Database error" });
            res.json(results);
        });
});

// Get group information API
app.get('/api/group/:groupId', verifyToken, (req, res) => {
    const groupId = req.params.groupId;
    
    db.query(`SELECT * FROM groups WHERE group_id = ?`, [groupId], (err, groupResults) => {
        if (err || groupResults.length === 0) {
            return res.status(404).json({ error: 'Group not found' });
        }
        
        const group = groupResults[0];
        
        // Get group members
        db.query(`
            SELECT u.username, u.last_seen, gm.joined_at 
            FROM group_members gm 
            JOIN users u ON gm.username = u.username 
            WHERE gm.group_id = ?
            ORDER BY gm.joined_at ASC
        `, [groupId], (err, memberResults) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to fetch group members' });
            }
            
            // Get online users from socket
            const onlineUsers = getOnlineUsers();
            const members = memberResults.map(member => ({
                username: member.username,
                last_seen: member.last_seen,
                joined_at: member.joined_at,
                is_online: onlineUsers.includes(member.username)
            }));
            
            // Get recent messages count
            db.query(`SELECT COUNT(*) as count FROM group_messages WHERE group_id = ?`, 
                [groupId], (err, countResults) => {
                    
                res.json({
                    group: {
                        ...group,
                        memberCount: members.length,
                        messageCount: countResults[0]?.count || 0
                    },
                    members: members
                });
            });
        });
    });
});

// Middleware to verify JWT for protected pages
function verifyToken(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1]; // Bearer TOKEN
    if (!token) return res.status(401).json({ error: "No token" });

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: "Invalid token" });
        req.user = decoded;
        next();
    });
}

app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/register.html'));
});

app.get('/chat', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/login.html'));
});

app.use('/uploads', express.static(UPLOAD_DIR));

// ------------------ SOCKET.IO ------------------
let onlineUsers = []; // Track currently online users

function getOnlineUsers() {
    return [...onlineUsers];
}

io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("No token"));

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error("Invalid token"));
        socket.username = decoded.username;
        next();
    });
});

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.username}`);

    // Add user to online users
    if (!onlineUsers.includes(socket.username)) {
        onlineUsers.push(socket.username);
        
        // Update last_seen timestamp in database
        db.query(`UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE username = ?`, [socket.username]);
    }

    // Send complete user list to ALL connected clients
    sendCompleteUserListToAll();

    socket.broadcast.emit('joinuser', `${socket.username} has joined the chat.`);
    socket.emit('set title', socket.username);

    // Get all registered users (for showing online/offline status)
    socket.on('get registered users', () => {
        console.log(`[DEBUG] ${socket.username} requested registered users`);
        sendCompleteUserListToAll();
    });

    // Private chat history
    socket.on('get history', (data) => {
        const withUser = data.withUser;
        const offset = data.offset || 0;
        const limit = data.limit || 10;
        
        db.query(`
            SELECT * FROM messages
            WHERE (sender = ? AND recipient = ?)
               OR (sender = ? AND recipient = ?)
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `, [socket.username, withUser, withUser, socket.username, limit, offset], (err, results) => {
            if (!err) {
                // Reverse to get chronological order
                socket.emit('history', results.reverse());
            } else {
                console.error('Error fetching history:', err);
            }
        });
    });

    // Broadcast history
    socket.on('get broadcast history', (data) => {
        const offset = data.offset || 0;
        const limit = data.limit || 60;
        
        db.query(`
            SELECT * FROM messages 
            WHERE recipient = 'ALL' 
            ORDER BY timestamp DESC 
            LIMIT ? OFFSET ?
        `, [limit, offset], (err, results) => {
            if (!err) {
                // Reverse to get chronological order
                socket.emit('history', results.reverse());
            } else {
                console.error('Error fetching broadcast history:', err);
            }
        });
    });

    // Private message - FIXED VERSION
    socket.on('private message', (msg) => {
        console.log('Private message received:', msg);
        
        // First store the message in database
        db.query(`INSERT INTO messages (sender, recipient, message) VALUES (?, ?, ?)`,
            [msg.sender, msg.recipient, msg.message],
            (err, result) => {
                if (err) {
                    console.error('Error storing private message:', err);
                    return;
                }
                
                console.log('Private message stored in database with ID:', result.insertId);
                
                // Get the complete message from database to ensure we have correct timestamp
                db.query(`SELECT * FROM messages WHERE id = ?`, [result.insertId], (err, results) => {
                    if (err || results.length === 0) {
                        console.error('Error fetching stored message:', err);
                        return;
                    }
                    
                    const storedMessage = results[0];
                    const messageObj = {
                        id: storedMessage.id,
                        sender: storedMessage.sender,
                        recipient: storedMessage.recipient,
                        message: storedMessage.message,
                        filename: storedMessage.filename,
                        filepath: storedMessage.filepath,
                        timestamp: storedMessage.timestamp
                    };

                    // Send to recipient if online
                    const recipientSocket = Array.from(io.sockets.sockets.values())
                        .find(s => s.username === msg.recipient);

                    if (recipientSocket) {
                        recipientSocket.emit('private message', messageObj);
                    }
                    
                    // Also send back to sender for confirmation
                    socket.emit('private message', messageObj);
                });
            });
    });

    // Broadcast message - FIXED VERSION
    socket.on('broadcast message', (message) => {
        console.log('Broadcast message received:', message);
        
        // First store the message in database
        db.query(`INSERT INTO messages (sender, recipient, message) VALUES (?, 'ALL', ?)`,
            [socket.username, message],
            (err, result) => {
                if (err) {
                    console.error('Error storing broadcast message:', err);
                    return;
                }
                
                console.log('Broadcast message stored in database with ID:', result.insertId);
                
                // Get the complete message from database to ensure we have correct timestamp
                db.query(`SELECT * FROM messages WHERE id = ?`, [result.insertId], (err, results) => {
                    if (err || results.length === 0) {
                        console.error('Error fetching stored broadcast message:', err);
                        return;
                    }
                    
                    const storedMessage = results[0];
                    const messageObj = {
                        id: storedMessage.id,
                        sender: storedMessage.sender,
                        recipient: storedMessage.recipient,
                        message: storedMessage.message,
                        filename: storedMessage.filename,
                        filepath: storedMessage.filepath,
                        timestamp: storedMessage.timestamp
                    };
                    
                    // Broadcast to all connected clients
                    io.emit('broadcast message', messageObj);
                });
            });
    });

    // File sharing - ENHANCED VERSION WITH GROUP SUPPORT
    socket.on('file', (data, callback) => {
        console.log('File upload received:', data.filename, 'Size:', data.fileSize, 'GroupId:', data.groupId);
        
        try {
            // Validate file
            const validation = validateFileUpload(data);
            if (!validation.valid) {
                if (callback) callback({ error: validation.error });
                return;
            }

            const fileBuffer = Buffer.from(data.file);
            const uniqueName = Date.now() + '-' + data.filename;
            const filePath = path.join(UPLOAD_DIR, uniqueName);

            fs.writeFileSync(filePath, fileBuffer);

            const fileLink = `/uploads/${uniqueName}`;
            
            // Check if it's a group file
            if (data.groupId) {
                // Store in group_messages table
                db.query(`INSERT INTO group_messages (group_id, sender, filename, filepath) VALUES (?, ?, ?, ?)`,
                    [data.groupId, data.sender, data.filename, fileLink],
                    (err, result) => {
                        if (err) {
                            console.error('Error storing group file message:', err);
                            if (callback) callback({ error: 'Database error' });
                            return;
                        }
                        
                        console.log('Group file message stored in database with ID:', result.insertId);
                        
                        // Get the complete group file message
                        db.query(`SELECT * FROM group_messages WHERE id = ?`, [result.insertId], (err, results) => {
                            if (err || results.length === 0) {
                                console.error('Error fetching stored group file:', err);
                                if (callback) callback({ error: 'Error fetching stored file' });
                                return;
                            }
                            
                            const storedMessage = results[0];
                            const fileMessage = {
                                id: storedMessage.id,
                                groupId: storedMessage.group_id,
                                sender: storedMessage.sender,
                                filename: storedMessage.filename,
                                filepath: storedMessage.filepath,
                                fileSize: data.fileSize,
                                fileType: data.fileType,
                                timestamp: storedMessage.timestamp
                            };
                            
                            // Get all group members
                            db.query(`SELECT username FROM group_members WHERE group_id = ?`,
                                [data.groupId],
                                (err, members) => {
                                    if (err) {
                                        console.error('Error fetching group members:', err);
                                        return;
                                    }
                                    
                                    // Send to all online group members
                                    members.forEach(member => {
                                        if (member.username !== data.sender) {
                                            const memberSocket = Array.from(io.sockets.sockets.values())
                                                .find(s => s.username === member.username);
                                            if (memberSocket) {
                                                memberSocket.emit('group file', fileMessage);
                                            }
                                        }
                                    });
                                    
                                    // Send back to sender
                                    socket.emit('group file', fileMessage);
                                    
                                    if (callback) callback({ success: true });
                                });
                        });
                    });
            } else {
                // Store in regular messages table (private or broadcast)
                const recipient = data.recipient || 'ALL';
                
                db.query(`INSERT INTO messages (sender, recipient, filename, filepath) VALUES (?, ?, ?, ?)`,
                    [data.sender, recipient, data.filename, fileLink],
                    (err, result) => {
                        if (err) {
                            console.error('Error storing file message:', err);
                            if (callback) callback({ error: 'Database error' });
                            return;
                        }
                        
                        console.log('File message stored in database with ID:', result.insertId);
                        
                        // Get the complete file message from database
                        db.query(`SELECT * FROM messages WHERE id = ?`, [result.insertId], (err, results) => {
                            if (err || results.length === 0) {
                                console.error('Error fetching stored file message:', err);
                                if (callback) callback({ error: 'Error fetching stored file' });
                                return;
                            }
                            
                            const storedMessage = results[0];
                            const fileMessage = {
                                id: storedMessage.id,
                                sender: storedMessage.sender,
                                recipient: storedMessage.recipient,
                                filename: storedMessage.filename,
                                filepath: storedMessage.filepath,
                                fileSize: data.fileSize,
                                fileType: data.fileType,
                                timestamp: storedMessage.timestamp
                            };

                            if (recipient === 'ALL') {
                                // Broadcast to all
                                io.emit('file', fileMessage);
                            } else {
                                // Send to specific recipient
                                const recipientSocket = Array.from(io.sockets.sockets.values())
                                    .find(s => s.username === recipient);
                                if (recipientSocket) {
                                    recipientSocket.emit('file', fileMessage);
                                }
                                // Also send back to sender
                                socket.emit('file', fileMessage);
                            }
                            
                            if (callback) callback({ success: true });
                        });
                    });
            }
        } catch (error) {
            console.error('Error processing file upload:', error);
            if (callback) callback({ error: 'File processing error: ' + error.message });
        }
    });

    // Create Group
    socket.on('create group', (data, callback) => {
        const { groupName, members } = data;
        const groupId = `group_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Start transaction
        db.query('START TRANSACTION', (err) => {
            if (err) {
                console.error('Transaction start error:', err);
                if (callback) callback({ error: 'Failed to create group' });
                return;
            }
            
            // Create group
            db.query(`INSERT INTO groups (group_id, group_name, created_by) VALUES (?, ?, ?)`,
                [groupId, groupName, socket.username],
                (err) => {
                    if (err) {
                        db.query('ROLLBACK');
                        console.error('Group creation error:', err);
                        if (callback) callback({ error: 'Failed to create group' });
                        return;
                    }
                    
                    // Add creator as member
                    const allMembers = [socket.username, ...members];
                    let completed = 0;
                    
                    allMembers.forEach((member) => {
                        db.query(`INSERT INTO group_members (group_id, username) VALUES (?, ?)`,
                            [groupId, member],
                            (err) => {
                                if (err && !err.message.includes('Duplicate entry')) {
                                    console.error('Add member error:', err);
                                }
                                
                                completed++;
                                if (completed === allMembers.length) {
                                    db.query('COMMIT', (err) => {
                                        if (err) {
                                            db.query('ROLLBACK');
                                            if (callback) callback({ error: 'Failed to create group' });
                                            return;
                                        }
                                        
                                        // Notify all members
                                        allMembers.forEach(member => {
                                            const memberSocket = Array.from(io.sockets.sockets.values())
                                                .find(s => s.username === member);
                                            if (memberSocket) {
                                                memberSocket.emit('group created', {
                                                    groupId: groupId,
                                                    groupName: groupName,
                                                    createdBy: socket.username,
                                                    members: allMembers
                                                });
                                                memberSocket.emit('get my groups');
                                            }
                                        });
                                        
                                        if (callback) callback({ success: true, groupId: groupId });
                                    });
                                }
                            });
                    });
                });
        });
    });

    // Get User's Groups
    socket.on('get my groups', (callback) => {
        db.query(`
            SELECT g.*, gm.joined_at 
            FROM groups g 
            JOIN group_members gm ON g.group_id = gm.group_id 
            WHERE gm.username = ?
            ORDER BY g.created_at DESC
        `, [socket.username], (err, results) => {
            if (err) {
                console.error('Error fetching groups:', err);
                if (callback) callback({ error: 'Failed to fetch groups' });
                return;
            }
            
            // Get member count for each group
            const groupsWithMembers = results.map(group => {
                return new Promise((resolve) => {
                    db.query(`SELECT COUNT(*) as count FROM group_members WHERE group_id = ?`,
                        [group.group_id],
                        (err, countResult) => {
                            if (err) {
                                resolve({ ...group, memberCount: 0 });
                            } else {
                                resolve({ ...group, memberCount: countResult[0].count });
                            }
                        });
                });
            });
            
            Promise.all(groupsWithMembers).then(groups => {
                if (callback) callback({ groups: groups });
            });
        });
    });

    // Get Group Members
    socket.on('get group members', (data, callback) => {
        const { groupId } = data;
        
        db.query(`
            SELECT u.username, u.last_seen, gm.joined_at 
            FROM group_members gm 
            JOIN users u ON gm.username = u.username 
            WHERE gm.group_id = ?
            ORDER BY gm.joined_at ASC
        `, [groupId], (err, results) => {
            if (err) {
                console.error('Error fetching group members:', err);
                if (callback) callback({ error: 'Failed to fetch members' });
                return;
            }
            
            const members = results.map(member => ({
                username: member.username,
                is_online: onlineUsers.includes(member.username),
                last_seen: member.last_seen,
                joined_at: member.joined_at
            }));
            
            if (callback) callback({ members: members });
        });
    });

    // Send Group Message
    socket.on('group message', (data, callback) => {
        const { groupId, message } = data;
        
        // Check if user is a member of the group
        db.query(`SELECT * FROM group_members WHERE group_id = ? AND username = ?`,
            [groupId, socket.username],
            (err, results) => {
                if (err || results.length === 0) {
                    if (callback) callback({ error: 'You are not a member of this group' });
                    return;
                }
                
                // Store group message
                db.query(`INSERT INTO group_messages (group_id, sender, message) VALUES (?, ?, ?)`,
                    [groupId, socket.username, message],
                    (err, result) => {
                        if (err) {
                            console.error('Error storing group message:', err);
                            if (callback) callback({ error: 'Failed to send message' });
                            return;
                        }
                        
                        // Get the stored message
                        db.query(`SELECT * FROM group_messages WHERE id = ?`,
                            [result.insertId],
                            (err, results) => {
                                if (err || results.length === 0) {
                                    console.error('Error fetching stored group message:', err);
                                    return;
                                }
                                
                                const storedMessage = results[0];
                                const messageObj = {
                                    id: storedMessage.id,
                                    groupId: storedMessage.group_id,
                                    sender: storedMessage.sender,
                                    message: storedMessage.message,
                                    is_forwarded: storedMessage.is_forwarded,
                                    original_sender: storedMessage.original_sender,
                                    original_timestamp: storedMessage.original_timestamp,
                                    timestamp: storedMessage.timestamp
                                };
                                
                                // Get all group members
                                db.query(`SELECT username FROM group_members WHERE group_id = ?`,
                                    [groupId],
                                    (err, members) => {
                                        if (err) return;
                                        
                                        // Send to all online members
                                        members.forEach(member => {
                                            if (member.username !== socket.username) {
                                                const memberSocket = Array.from(io.sockets.sockets.values())
                                                    .find(s => s.username === member.username);
                                                if (memberSocket) {
                                                    memberSocket.emit('group message', messageObj);
                                                }
                                            }
                                        });
                                        
                                        // Send back to sender
                                        socket.emit('group message', messageObj);
                                        
                                        if (callback) callback({ success: true });
                                    });
                            });
                    });
            });
    });

    // Get Group History
    socket.on('get group history', (data, callback) => {
        const { groupId, offset = 0, limit = 50 } = data;
        
        db.query(`
            SELECT * FROM group_messages 
            WHERE group_id = ? 
            ORDER BY timestamp DESC 
            LIMIT ? OFFSET ?
        `, [groupId, limit, offset], (err, results) => {
            if (err) {
                console.error('Error fetching group history:', err);
                if (callback) callback({ error: 'Failed to fetch history' });
                return;
            }
            
            if (callback) callback({ messages: results.reverse() });
        });
    });

    // Forward Message - FIXED VERSION FOR FILES
 // Forward Message - ENHANCED VERSION FOR ALL MESSAGE TYPES
socket.on('forward message', (data, callback) => {
    const { originalMessage, recipients } = data;
    
    console.log('Forward message request:', originalMessage, 'Recipients:', recipients);
    
    if (!originalMessage || !recipients || recipients.length === 0) {
        if (callback) callback({ error: 'Invalid forward request' });
        return;
    }
    
    // Determine message type
    const isFileMessage = originalMessage.filename || originalMessage.filepath;
    const isGroupMessage = originalMessage.isGroupMessage || false;
    const originalGroupId = originalMessage.groupId;
    
    console.log('Message type - File:', isFileMessage, 'Group:', isGroupMessage, 'GroupId:', originalGroupId);
    
    const forwardedMessages = [];
    let processedCount = 0;
    
    recipients.forEach(recipient => {
        console.log('Forwarding to recipient:', recipient);
        
        if (recipient.type === 'group') {
            // Forward to group
            const groupId = recipient.id;
            
            // Check if user is a member of this group
            db.query(`SELECT * FROM group_members WHERE group_id = ? AND username = ?`,
                [groupId, socket.username],
                (err, results) => {
                    if (err || results.length === 0) {
                        console.error('User not a member of group:', groupId);
                        processedCount++;
                        checkCompletion();
                        return;
                    }
                    
                    if (isFileMessage) {
                        // Forward file message to group
                        db.query(`INSERT INTO group_messages (group_id, sender, filename, filepath, is_forwarded, original_sender, original_timestamp) 
                                 VALUES (?, ?, ?, ?, TRUE, ?, ?)`,
                            [groupId, socket.username, 
                             originalMessage.filename,
                             originalMessage.filepath,
                             originalMessage.original_sender || originalMessage.sender,
                             originalMessage.original_timestamp],
                            (err, result) => {
                                if (err) {
                                    console.error('Error storing forwarded group file message:', err);
                                    processedCount++;
                                    checkCompletion();
                                    return;
                                }
                                
                                // Get stored message
                                db.query(`SELECT * FROM group_messages WHERE id = ?`,
                                    [result.insertId],
                                    (err, results) => {
                                        if (err || results.length === 0) {
                                            processedCount++;
                                            checkCompletion();
                                            return;
                                        }
                                        
                                        const storedMessage = results[0];
                                        const messageObj = {
                                            id: storedMessage.id,
                                            groupId: storedMessage.group_id,
                                            sender: storedMessage.sender,
                                            filename: storedMessage.filename,
                                            filepath: storedMessage.filepath,
                                            is_forwarded: storedMessage.is_forwarded,
                                            original_sender: storedMessage.original_sender,
                                            original_timestamp: storedMessage.original_timestamp,
                                            timestamp: storedMessage.timestamp
                                        };
                                        
                                        // Get all group members
                                        db.query(`SELECT username FROM group_members WHERE group_id = ?`,
                                            [groupId],
                                            (err, members) => {
                                                if (err) {
                                                    processedCount++;
                                                    checkCompletion();
                                                    return;
                                                }
                                                
                                                // Send to all group members
                                                members.forEach(member => {
                                                    const memberSocket = Array.from(io.sockets.sockets.values())
                                                        .find(s => s.username === member.username);
                                                    if (memberSocket) {
                                                        memberSocket.emit('group message', messageObj);
                                                    }
                                                });
                                                
                                                forwardedMessages.push({
                                                    type: 'group',
                                                    id: groupId,
                                                    success: true
                                                });
                                                processedCount++;
                                                checkCompletion();
                                            });
                                    });
                            });
                    } else {
                        // Forward text message to group
                        db.query(`INSERT INTO group_messages (group_id, sender, message, is_forwarded, original_sender, original_timestamp) 
                                 VALUES (?, ?, ?, TRUE, ?, ?)`,
                            [groupId, socket.username, 
                             originalMessage.message,
                             originalMessage.original_sender || originalMessage.sender,
                             originalMessage.original_timestamp],
                            (err, result) => {
                                if (err) {
                                    console.error('Error storing forwarded group message:', err);
                                    processedCount++;
                                    checkCompletion();
                                    return;
                                }
                                
                                // Get stored message
                                db.query(`SELECT * FROM group_messages WHERE id = ?`,
                                    [result.insertId],
                                    (err, results) => {
                                        if (err || results.length === 0) {
                                            processedCount++;
                                            checkCompletion();
                                            return;
                                        }
                                        
                                        const storedMessage = results[0];
                                        const messageObj = {
                                            id: storedMessage.id,
                                            groupId: storedMessage.group_id,
                                            sender: storedMessage.sender,
                                            message: storedMessage.message,
                                            is_forwarded: storedMessage.is_forwarded,
                                            original_sender: storedMessage.original_sender,
                                            original_timestamp: storedMessage.original_timestamp,
                                            timestamp: storedMessage.timestamp
                                        };
                                        
                                        // Get all group members
                                        db.query(`SELECT username FROM group_members WHERE group_id = ?`,
                                            [groupId],
                                            (err, members) => {
                                                if (err) {
                                                    processedCount++;
                                                    checkCompletion();
                                                    return;
                                                }
                                                
                                                // Send to all group members
                                                members.forEach(member => {
                                                    const memberSocket = Array.from(io.sockets.sockets.values())
                                                        .find(s => s.username === member.username);
                                                    if (memberSocket) {
                                                        memberSocket.emit('group message', messageObj);
                                                    }
                                                });
                                                
                                                forwardedMessages.push({
                                                    type: 'group',
                                                    id: groupId,
                                                    success: true
                                                });
                                                processedCount++;
                                                checkCompletion();
                                            });
                                    });
                            });
                    }
                });
        } else {
            // Forward to user (private message)
            const recipientUsername = recipient.id;
            
            // Check if recipient exists
            db.query(`SELECT username FROM users WHERE username = ?`, 
                [recipientUsername], 
                (err, results) => {
                    if (err || results.length === 0) {
                        console.error('Recipient not found:', recipientUsername);
                        processedCount++;
                        checkCompletion();
                        return;
                    }
                    
                    if (isFileMessage) {
                        // Forward file message to user
                        db.query(`INSERT INTO messages (sender, recipient, filename, filepath) VALUES (?, ?, ?, ?)`,
                            [socket.username, recipientUsername, 
                             originalMessage.filename,
                             originalMessage.filepath],
                            (err, result) => {
                                if (err) {
                                    console.error('Error storing forwarded private file message:', err);
                                    processedCount++;
                                    checkCompletion();
                                    return;
                                }
                                
                                // Get stored message
                                db.query(`SELECT * FROM messages WHERE id = ?`,
                                    [result.insertId],
                                    (err, results) => {
                                        if (err || results.length === 0) {
                                            processedCount++;
                                            checkCompletion();
                                            return;
                                        }
                                        
                                        const storedMessage = results[0];
                                        const messageObj = {
                                            id: storedMessage.id,
                                            sender: storedMessage.sender,
                                            recipient: storedMessage.recipient,
                                            filename: storedMessage.filename,
                                            filepath: storedMessage.filepath,
                                            is_forwarded: true,
                                            original_sender: originalMessage.original_sender || originalMessage.sender,
                                            original_timestamp: originalMessage.original_timestamp,
                                            timestamp: storedMessage.timestamp
                                        };
                                        
                                        // Send to recipient if online
                                        const recipientSocket = Array.from(io.sockets.sockets.values())
                                            .find(s => s.username === recipientUsername);
                                        if (recipientSocket) {
                                            recipientSocket.emit('file', messageObj);
                                        }
                                        
                                        // Also send back to sender
                                        socket.emit('file', messageObj);
                                        
                                        forwardedMessages.push({
                                            type: 'user',
                                            username: recipientUsername,
                                            success: true
                                        });
                                        processedCount++;
                                        checkCompletion();
                                    });
                            });
                    } else {
                        // Forward text message to user
                        db.query(`INSERT INTO messages (sender, recipient, message) VALUES (?, ?, ?)`,
                            [socket.username, recipientUsername, 
                             originalMessage.message],
                            (err, result) => {
                                if (err) {
                                    console.error('Error storing forwarded private message:', err);
                                    processedCount++;
                                    checkCompletion();
                                    return;
                                }
                                
                                // Get stored message
                                db.query(`SELECT * FROM messages WHERE id = ?`,
                                    [result.insertId],
                                    (err, results) => {
                                        if (err || results.length === 0) {
                                            processedCount++;
                                            checkCompletion();
                                            return;
                                        }
                                        
                                        const storedMessage = results[0];
                                        const messageObj = {
                                            id: storedMessage.id,
                                            sender: storedMessage.sender,
                                            recipient: storedMessage.recipient,
                                            message: storedMessage.message,
                                            is_forwarded: true,
                                            original_sender: originalMessage.original_sender || originalMessage.sender,
                                            original_timestamp: originalMessage.original_timestamp,
                                            timestamp: storedMessage.timestamp
                                        };
                                        
                                        // Send to recipient if online
                                        const recipientSocket = Array.from(io.sockets.sockets.values())
                                            .find(s => s.username === recipientUsername);
                                        if (recipientSocket) {
                                            recipientSocket.emit('private message', messageObj);
                                        }
                                        
                                        // Also send back to sender
                                        socket.emit('private message', messageObj);
                                        
                                        forwardedMessages.push({
                                            type: 'user',
                                            username: recipientUsername,
                                            success: true
                                        });
                                        processedCount++;
                                        checkCompletion();
                                    });
                            });
                    }
                });
        }
    });
    
    function checkCompletion() {
        if (processedCount === recipients.length) {
            const successCount = forwardedMessages.filter(m => m.success).length;
            const errorCount = recipients.length - successCount;
            
            console.log(`Forward completed: ${successCount} successful, ${errorCount} failed`);
            
            if (callback) {
                if (successCount > 0) {
                    callback({ 
                        success: true, 
                        message: `Forwarded to ${successCount} recipient(s)`,
                        details: forwardedMessages 
                    });
                } else {
                    callback({ error: 'Failed to forward to any recipients' });
                }
            }
            
            // Notify sender
            if (successCount > 0) {
                socket.emit('message forwarded', {
                    success: true,
                    count: successCount
                });
            }
        }
    }
});

    // Add Members to Group
    socket.on('add group members', (data, callback) => {
        const { groupId, members } = data;
        
        // Check if user is group creator
        db.query(`SELECT created_by FROM groups WHERE group_id = ?`,
            [groupId],
            (err, results) => {
                if (err || results.length === 0 || results[0].created_by !== socket.username) {
                    if (callback) callback({ error: 'Only group creator can add members' });
                    return;
                }
                
                let completed = 0;
                const addedMembers = [];
                
                members.forEach((member) => {
                    db.query(`INSERT IGNORE INTO group_members (group_id, username) VALUES (?, ?)`,
                        [groupId, member],
                        (err) => {
                            if (!err) addedMembers.push(member);
                            
                            completed++;
                            if (completed === members.length) {
                                // Notify all group members about new members
                                db.query(`SELECT username FROM group_members WHERE group_id = ?`,
                                    [groupId],
                                    (err, allMembers) => {
                                        allMembers.forEach(member => {
                                            const memberSocket = Array.from(io.sockets.sockets.values())
                                                .find(s => s.username === member.username);
                                            if (memberSocket) {
                                                memberSocket.emit('group members updated', {
                                                    groupId: groupId,
                                                    addedMembers: addedMembers,
                                                    addedBy: socket.username
                                                });
                                                memberSocket.emit('get my groups');
                                            }
                                        });
                                        
                                        if (callback) callback({ 
                                            success: true, 
                                            addedMembers: addedMembers 
                                        });
                                    });
                            }
                        });
                });
            });
    });

    // Delete Group
    socket.on('delete group', (data, callback) => {
        const { groupId } = data;
        
        // Check if user is group creator
        db.query(`SELECT created_by FROM groups WHERE group_id = ?`,
            [groupId],
            (err, results) => {
                if (err || results.length === 0 || results[0].created_by !== socket.username) {
                    if (callback) callback({ error: 'Only group creator can delete group' });
                    return;
                }
                
                // Get all members before deletion
                db.query(`SELECT username FROM group_members WHERE group_id = ?`,
                    [groupId],
                    (err, members) => {
                        // Delete group (cascade will delete members and messages)
                        db.query(`DELETE FROM groups WHERE group_id = ?`,
                            [groupId],
                            (err) => {
                                if (err) {
                                    if (callback) callback({ error: 'Failed to delete group' });
                                    return;
                                }
                                
                                // Notify all former members
                                members.forEach(member => {
                                    const memberSocket = Array.from(io.sockets.sockets.values())
                                        .find(s => s.username === member.username);
                                    if (memberSocket) {
                                        memberSocket.emit('group deleted', { groupId: groupId });
                                        memberSocket.emit('get my groups');
                                    }
                                });
                                
                                if (callback) callback({ success: true });
                            });
                    });
            });
    });

    // Get group file history
    socket.on('get group file history', (data, callback) => {
        const { groupId, offset = 0, limit = 50 } = data;
        
        db.query(`
            SELECT * FROM group_messages 
            WHERE group_id = ? AND filename IS NOT NULL
            ORDER BY timestamp DESC 
            LIMIT ? OFFSET ?
        `, [groupId, limit, offset], (err, results) => {
            if (err) {
                console.error('Error fetching group file history:', err);
                if (callback) callback({ error: 'Failed to fetch file history' });
                return;
            }
            
            if (callback) callback({ files: results.reverse() });
        });
    });

    // Typing indicators
    socket.on('typing', (data) => {
        const toSocket = Array.from(io.sockets.sockets.values())
            .find(s => s.username === data.recipient);
        if (toSocket) toSocket.emit('typing', { sender: socket.username });
    });

    socket.on('stop typing', (data) => {
        const toSocket = Array.from(io.sockets.sockets.values())
            .find(s => s.username === data.recipient);
        if (toSocket) toSocket.emit('stop typing', { sender: socket.username });
    });

    // Disconnect
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.username}`);
        onlineUsers = onlineUsers.filter(u => u !== socket.username);
        
        // Update last_seen timestamp when user disconnects
        db.query(`UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE username = ?`, [socket.username]);
        
        // Notify other users about the updated user list
        sendCompleteUserListToAll();
        socket.broadcast.emit('disconnecteduser', `${socket.username} has left the chat.`);
    });

    // Function to send complete user list to ALL clients
    function sendCompleteUserListToAll() {
        console.log(`[DEBUG] Sending user list to all clients. Online users: ${onlineUsers.length}`);
        
        // Get ALL users from database (excluding current user)
        db.query(`SELECT username, last_seen FROM users WHERE username != ? ORDER BY username`, 
            [socket.username], 
            (err, results) => {
                if (err) {
                    console.error('[ERROR] Database error fetching users:', err);
                    return;
                }
                
                // Create user list with online/offline status
                const userList = results.map(user => ({
                    username: user.username,
                    is_online: onlineUsers.includes(user.username),
                    last_seen: user.last_seen
                }));
                
                // Also send user's group list
                db.query(`
                    SELECT g.* FROM groups g 
                    JOIN group_members gm ON g.group_id = gm.group_id 
                    WHERE gm.username = ?
                    ORDER BY g.created_at DESC
                `, [socket.username], (err, groups) => {
                    if (!err) {
                        // Get member count for each group
                        const groupsWithMembers = groups.map(group => {
                            return new Promise((resolve) => {
                                db.query(`SELECT COUNT(*) as count FROM group_members WHERE group_id = ?`,
                                    [group.group_id],
                                    (err, countResult) => {
                                        if (err) {
                                            resolve({ ...group, memberCount: 0 });
                                        } else {
                                            resolve({ ...group, memberCount: countResult[0].count });
                                        }
                                    });
                            });
                        });
                        
                        Promise.all(groupsWithMembers).then(groupsList => {
                            // Send complete data to client
                            socket.emit('registered users', {
                                allUsers: userList,
                                onlineUsers: onlineUsers,
                                groups: groupsList
                            });
                        });
                    } else {
                        // Send only user list if groups query fails
                        socket.emit('registered users', {
                            allUsers: userList,
                            onlineUsers: onlineUsers,
                            groups: []
                        });
                    }
                });
            });
    }
});

server.listen(3000, () => {
    console.log('Server running at http://localhost:3000');
});