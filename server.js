const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST", "OPTIONS"],
        credentials: true,
        allowedHeaders: ["*"]
    },
    path: '/socket.io',
    transports: ['polling', 'websocket'],
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e8,
    allowUpgrades: true
});

const path = require('path');
const PORT = process.env.PORT || 3000;

// Store active rooms and users
const rooms = new Map();
const users = new Map();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// Generate random room ID
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Generate random username
function generateUsername() {
    const adjectives = ['Happy', 'Lucky', 'Sunny', 'Clever', 'Swift', 'Bright', 'Cool', 'Smart'];
    const nouns = ['Panda', 'Tiger', 'Eagle', 'Dolphin', 'Lion', 'Fox', 'Wolf', 'Bear'];
    return `${adjectives[Math.floor(Math.random() * adjectives.length)]}${nouns[Math.floor(Math.random() * nouns.length)]}`;
}

// API Routes
app.post('/api/rooms', (req, res) => {
    try {
        const roomId = generateRoomId();
        const room = {
            id: roomId,
            users: new Set(),
            screenSharer: null,
            messages: [],
            createdAt: Date.now()
        };
        rooms.set(roomId, room);
        console.log('Room created:', roomId);
        res.json({ roomId, created: true });
    } catch (error) {
        console.error('Error creating room:', error);
        res.status(500).json({ error: 'Failed to create room' });
    }
});

app.get('/api/rooms/:roomId', (req, res) => {
    try {
        const { roomId } = req.params;
        const room = rooms.get(roomId);
        if (room) {
            const roomUsers = Array.from(room.users)
                .map(userId => users.get(userId))
                .filter(Boolean);
            res.json({ 
                exists: true, 
                users: roomUsers,
                screenSharer: room.screenSharer,
                messages: room.messages
            });
        } else {
            res.status(404).json({ exists: false });
        }
    } catch (error) {
        console.error('Error getting room:', error);
        res.status(500).json({ error: 'Failed to get room info' });
    }
});

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handle room routes
app.get('/room/:roomId', (req, res) => {
    const { roomId } = req.params;
    console.log('Accessing room:', roomId);
    
    // Validate room ID format
    if (!/^[A-Z0-9]{6}$/.test(roomId)) {
        console.log('Invalid room ID format:', roomId);
        return res.redirect('/');
    }
    
    // Create room if it doesn't exist
    if (!rooms.has(roomId)) {
        console.log('Creating new room:', roomId);
        rooms.set(roomId, {
            id: roomId,
            users: new Set(),
            screenSharer: null,
            messages: [],
            createdAt: Date.now()
        });
    }
    
    // Send room.html file
    const roomHtmlPath = path.join(__dirname, 'public', 'room.html');
    console.log('Serving room.html from:', roomHtmlPath);
    res.sendFile(roomHtmlPath);
});

// Catch-all route for static files
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', req.path));
});

// Socket connection handling
io.on('connection', socket => {
    console.log('User connected:', socket.id);
    
    socket.on('join-room', (roomId, userId) => {
        try {
            console.log('User joining room:', { roomId, userId, socketId: socket.id });
            
            // Leave previous room if any
            const prevRoom = [...socket.rooms].find(room => room !== socket.id);
            if (prevRoom) {
                socket.leave(prevRoom);
                const room = rooms.get(prevRoom);
                if (room) {
                    room.users.delete(userId);
                    if (room.users.size === 0) {
                        rooms.delete(prevRoom);
                    }
                }
            }

            // Create user if doesn't exist or update socket id
            if (!users.has(userId)) {
                users.set(userId, {
                    id: userId,
                    socketId: socket.id,
                    name: generateUsername(),
                    avatar: `https://api.dicebear.com/6.x/adventurer/svg?seed=${userId}`,
                    roomId: roomId,
                    joinedAt: Date.now()
                });
            } else {
                const user = users.get(userId);
                user.socketId = socket.id;
                user.roomId = roomId;
            }

            // Initialize room if doesn't exist
            if (!rooms.has(roomId)) {
                rooms.set(roomId, {
                    id: roomId,
                    users: new Set(),
                    screenSharer: null,
                    messages: [],
                    createdAt: Date.now()
                });
            }

            const room = rooms.get(roomId);
            room.users.add(userId);
            socket.join(roomId);

            // Send current room state to the new user
            const roomUsers = Array.from(room.users)
                .map(id => users.get(id))
                .filter(Boolean);

            socket.emit('room-state', {
                users: roomUsers,
                screenSharer: room.screenSharer,
                messages: room.messages
            });

            // Broadcast to others in room
            socket.to(roomId).emit('user-connected', users.get(userId));

            // Handle screen sharing
            socket.on('screen-sharing-started', stream => {
                console.log('Screen sharing started:', userId);
                if (room) {
                    room.screenSharer = userId;
                    socket.to(roomId).emit('user-screen-share', userId, stream);
                }
            });

            socket.on('screen-sharing-stopped', () => {
                console.log('Screen sharing stopped:', userId);
                if (room && room.screenSharer === userId) {
                    room.screenSharer = null;
                    socket.to(roomId).emit('user-screen-share-stopped', userId);
                }
            });

            // Handle chat messages
            socket.on('chat-message', message => {
                console.log('Chat message:', message);
                const messageObj = {
                    id: Date.now(),
                    userId,
                    userName: users.get(userId).name,
                    message,
                    timestamp: Date.now()
                };
                room.messages.push(messageObj);
                io.to(roomId).emit('chat-message', messageObj);
            });

            // Handle user typing
            socket.on('typing-start', () => {
                socket.to(roomId).emit('user-typing', userId);
            });

            socket.on('typing-stop', () => {
                socket.to(roomId).emit('user-typing-stop', userId);
            });

        } catch (error) {
            console.error('Error in join-room:', error);
            socket.emit('error', 'Failed to join room');
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        // Find and clean up user
        for (const [userId, user] of users.entries()) {
            if (user.socketId === socket.id) {
                const room = rooms.get(user.roomId);
                if (room) {
                    room.users.delete(userId);
                    socket.to(user.roomId).emit('user-disconnected', userId);
                    
                    // Clean up empty room
                    if (room.users.size === 0) {
                        rooms.delete(user.roomId);
                    }
                }
                users.delete(userId);
                break;
            }
        }
    });
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});