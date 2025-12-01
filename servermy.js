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

    // File sharing - FIXED VERSION (matches your table structure)
    socket.on('file', (data, callback) => {
        console.log('File upload received:', data.filename, 'Size:', data.fileSize);
        
        try {
            const fileBuffer = Buffer.from(data.file);
            const uniqueName = Date.now() + '-' + data.filename;
            const filePath = path.join(UPLOAD_DIR, uniqueName);

            fs.writeFileSync(filePath, fileBuffer);

            const fileLink = `/uploads/${uniqueName}`;
            
            // Store file info in database (only columns that exist in your table)
            db.query(`INSERT INTO messages (sender, recipient, filename, filepath) VALUES (?, ?, ?, ?)`,
                [data.sender, data.recipient, data.filename, fileLink],
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
                            fileSize: data.fileSize, // Include fileSize in the message object for client
                            fileType: data.fileType, // Include fileType in the message object for client
                            timestamp: storedMessage.timestamp
                        };

                        if (data.recipient === 'ALL') {
                            // Broadcast to all
                            io.emit('file', fileMessage);
                        } else {
                            // Send to specific recipient
                            const recipientSocket = Array.from(io.sockets.sockets.values())
                                .find(s => s.username === data.recipient);
                            if (recipientSocket) {
                                recipientSocket.emit('file', fileMessage);
                            }
                            // Also send back to sender
                            socket.emit('file', fileMessage);
                        }
                        
                        if (callback) callback({ success: true });
                    });
                });
        } catch (error) {
            console.error('Error processing file upload:', error);
            if (callback) callback({ error: 'File processing error' });
        }
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
                
                console.log(`[DEBUG] Database returned ${results.length} users:`);
                results.forEach(user => {
                    console.log(`  - ${user.username} (last_seen: ${user.last_seen})`);
                });
                
                // Create user list with online/offline status
                const userList = results.map(user => ({
                    username: user.username,
                    is_online: onlineUsers.includes(user.username),
                    last_seen: user.last_seen
                }));
                
                const onlineCount = userList.filter(user => user.is_online).length;
                const offlineCount = userList.filter(user => !user.is_online).length;
                
                console.log(`[DEBUG] Sending: ${onlineCount} online, ${offlineCount} offline users`);
                console.log(`[DEBUG] Online users:`, onlineUsers);
                console.log(`[DEBUG] Full user list:`, userList);
                
                // Send to ALL connected clients
                io.emit('registered users', {
                    allUsers: userList,
                    onlineUsers: onlineUsers
                });
                
                console.log(`[DEBUG] User list sent to all clients`);
            });
    }
});

server.listen(3000, () => {
    console.log('Server running at http://localhost:3000');
});