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
app.use(express.json()); // Parse JSON body

// JWT secret key
const JWT_SECRET = "7877618775";

// Ensure upload folder exists
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR);
}

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
        password VARCHAR(255)
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

        const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '1h' });

        // Send username along with token
        res.json({ token, username: user.username });
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
// Serve chat only if authenticated
app.get('/chat', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve login page without authentication
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/login.html'));
});

app.use('/uploads', express.static(UPLOAD_DIR));

// ------------------ SOCKET.IO ------------------
let users = [];

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

    if (!users.includes(socket.username)) {
        users.push(socket.username);
        io.emit('update user list', users);
        socket.broadcast.emit('joinuser', `${socket.username} has joined the chat.`);
        socket.emit('set title', socket.username);
    }

    // Private chat history
    socket.on('get history', (data) => {
        const withUser = data.withUser;
        db.query(`
            SELECT * FROM messages
            WHERE (sender = ? AND recipient = ?)
               OR (sender = ? AND recipient = ?)
            ORDER BY timestamp ASC
        `, [socket.username, withUser, withUser, socket.username], (err, results) => {
            if (!err) socket.emit('history', results);
        });
    });

    // Broadcast history
    socket.on('get broadcast history', () => {
        db.query(`SELECT * FROM messages WHERE recipient = 'ALL' ORDER BY timestamp ASC`, (err, results) => {
            if (!err) socket.emit('history', results);
        });
    });

    // Private message
    socket.on('private message', (msg) => {
        db.query(`INSERT INTO messages (sender, recipient, message) VALUES (?, ?, ?)`,
            [msg.sender, msg.recipient, msg.message]);

        const recipientSocket = Array.from(io.sockets.sockets.values())
            .find(s => s.username === msg.recipient);

        if (recipientSocket) recipientSocket.emit('private message', msg);
        socket.emit('private message', msg);
    });

    // Broadcast message
    socket.on('broadcast message', (message) => {
        db.query(`INSERT INTO messages (sender, recipient, message) VALUES (?, 'ALL', ?)`,
            [socket.username, message]);
        io.emit('broadcast message', { sender: socket.username, message });
    });

    // File sharing
    socket.on('file', (data) => {
        const fileBuffer = Buffer.from(data.file);
        const uniqueName = Date.now() + '-' + data.filename;
        const filePath = path.join(UPLOAD_DIR, uniqueName);

        fs.writeFileSync(filePath, fileBuffer);

        const fileLink = `/uploads/${uniqueName}`;
        db.query(`INSERT INTO messages (sender, recipient, filename, filepath) VALUES (?, ?, ?, ?)`,
            [data.sender, data.recipient, data.filename, fileLink]);

        const payload = {
            sender: data.sender,
            recipient: data.recipient,
            filename: data.filename,
            filepath: fileLink
        };

        if (data.recipient === 'ALL') {
            io.emit('file', payload);
        } else {
            const toSocket = Array.from(io.sockets.sockets.values())
                .find(s => s.username === data.recipient);
            if (toSocket) toSocket.emit('file', payload);
            socket.emit('file', payload);
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
        users = users.filter(u => u !== socket.username);
        io.emit('update user list', users);
        socket.broadcast.emit('disconnecteduser', `${socket.username} has left the chat.`);
    });
});

server.listen(3000, () => {
    console.log('Server running at http://localhost:3000');
});
