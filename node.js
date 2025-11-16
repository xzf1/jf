const fs = require('fs');
const WebSocket = require('ws');

const server = new WebSocket.Server({ host: '0.0.0.0', port: 8081 });

const usersFile = 'users.json';
const offlineMessagesFile = 'offlineMessages.json';
const adminFile = 'admin.json';

let users = {};
let offlineMessages = {};
let adminCredentials = { username: 'admin', password: 'admin123' };

// 初始化文件
if (!fs.existsSync(usersFile)) {
  fs.writeFileSync(usersFile, '{}');
}

if (!fs.existsSync(offlineMessagesFile)) {
  fs.writeFileSync(offlineMessagesFile, '{}');
}

// 初始化管理员配置文件
if (!fs.existsSync(adminFile)) {
  fs.writeFileSync(adminFile, JSON.stringify(adminCredentials));
} else {
  try {
    adminCredentials = JSON.parse(fs.readFileSync(adminFile, 'utf8'));
  } catch (e) {
    console.log('使用默认管理员凭据');
  }
}

// 加载用户数据
try {
  users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
} catch (e) {
  users = {};
}

// 加载离线消息
try {
  offlineMessages = JSON.parse(fs.readFileSync(offlineMessagesFile, 'utf8'));
} catch (e) {
  offlineMessages = {};
}

const onlineUsers = new Map();

// 保存离线消息到文件
function saveOfflineMessages() {
  fs.writeFile(offlineMessagesFile, JSON.stringify(offlineMessages), (err) => {
    if (err) console.error('保存离线消息失败:', err);
  });
}

// 保存用户数据到文件
function saveUsers() {
  fs.writeFile(usersFile, JSON.stringify(users), (err) => {
    if (err) console.error('保存用户数据失败:', err);
  });
}

// 保存管理员凭据
function saveAdminCredentials() {
  fs.writeFile(adminFile, JSON.stringify(adminCredentials), (err) => {
    if (err) console.error('保存管理员凭据失败:', err);
  });
}

server.on('connection', (socket) => {
  console.log('新客户端连接:', socket._socket.remoteAddress);
  
  // 添加心跳检测
  let heartbeat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ping' }));
    } else {
      clearInterval(heartbeat);
    }
  }, 30000);

  socket.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'pong') return; // 忽略心跳响应
      handleControlMessage(socket, data);
    } catch (error) {
      console.error('消息解析错误:', error);
    }
  });

  socket.on('close', () => {
    clearInterval(heartbeat);
    onlineUsers.forEach((value, key) => {
      if (value === socket) onlineUsers.delete(key);
    });
    console.log('客户端断开:', socket._socket.remoteAddress);
  });
});

function handleControlMessage(socket, data) {
  const { action, username, password } = data;
  
  switch (action) {
    case 'register':
      if (users[username]) {
        socket.send(JSON.stringify({ success: false, message: '用户名已存在' }));
      } else {
        users[username] = password;
        saveUsers();
        socket.send(JSON.stringify({ success: true }));
      }
      break;

    case 'login':
      if (users[username] && users[username] === password) {
        // 检查用户是否已在线
        if (onlineUsers.has(username)) {
          socket.send(JSON.stringify({ 
            success: false, 
            message: '账号已在别处登录',
            action: 'login'
          }));
          return;
        }
        
        onlineUsers.set(username, socket);
        socket.user = { username };
        
        // 发送离线消息
        if (offlineMessages[username] && offlineMessages[username].length > 0) {
          socket.send(JSON.stringify({
            type: 'offline-messages',
            messages: offlineMessages[username]
          }));
          
          delete offlineMessages[username];
          saveOfflineMessages();
        }
        
        socket.send(JSON.stringify({ 
          success: true, 
          message: '登录成功',
          action: 'login'
        }));
      } else {
        socket.send(JSON.stringify({ 
          success: false, 
          message: '认证失败',
          action: 'login'
        }));
      }
      break;

    case 'reconnect':
      if (users[username] && users[username] === password) {
        // 对于重连，允许踢出旧连接
        if (onlineUsers.has(username)) {
          onlineUsers.get(username).close();
        }
        
        onlineUsers.set(username, socket);
        socket.user = { username };
        
        // 发送离线消息
        if (offlineMessages[username] && offlineMessages[username].length > 0) {
          socket.send(JSON.stringify({
            type: 'offline-messages',
            messages: offlineMessages[username]
          }));
          
          delete offlineMessages[username];
          saveOfflineMessages();
        }
        
        socket.send(JSON.stringify({ 
          success: true, 
          message: '重连成功',
          action: 'reconnect'
        }));
      } else {
        socket.send(JSON.stringify({ 
          success: false, 
          message: '认证失败',
          action: 'reconnect'
        }));
      }
      break;

    case 'admin-login':
      if (data.adminUsername === adminCredentials.username && 
          data.adminPassword === adminCredentials.password) {
        socket.isAdmin = true;
        socket.send(JSON.stringify({ 
          success: true, 
          message: '管理员登录成功',
          action: 'admin-login'
        }));
        // 发送当前在线用户列表
        sendOnlineUsersList(socket);
        // 发送所有用户列表
        sendAllUsersList(socket);
      } else {
        socket.send(JSON.stringify({ 
          success: false, 
          message: '管理员认证失败',
          action: 'admin-login'
        }));
      }
      break;

    case 'admin-add-user':
      if (!socket.isAdmin) {
        socket.send(JSON.stringify({ 
          success: false, 
          message: '无权限执行此操作',
          action: 'admin-add-user'
        }));
        return;
      }
      
      if (users[data.newUsername]) {
        socket.send(JSON.stringify({ 
          success: false, 
          message: '用户名已存在',
          action: 'admin-add-user'
        }));
      } else {
        users[data.newUsername] = data.newPassword;
        saveUsers();
        socket.send(JSON.stringify({ 
          success: true, 
          message: '用户添加成功',
          action: 'admin-add-user'
        }));
        // 更新所有管理员的所有用户列表
        broadcastAllUsersList();
      }
      break;

    case 'admin-delete-user':
      if (!socket.isAdmin) {
        socket.send(JSON.stringify({ 
          success: false, 
          message: '无权限执行此操作',
          action: 'admin-delete-user'
        }));
        return;
      }
      
      if (users[data.targetUsername]) {
        // 如果用户在线，先踢下线
        if (onlineUsers.has(data.targetUsername)) {
          onlineUsers.get(data.targetUsername).close();
          onlineUsers.delete(data.targetUsername);
        }
        
        // 删除用户数据
        delete users[data.targetUsername];
        // 删除离线消息
        delete offlineMessages[data.targetUsername];
        
        saveUsers();
        saveOfflineMessages();
        
        socket.send(JSON.stringify({ 
          success: true, 
          message: '用户删除成功',
          action: 'admin-delete-user'
        }));
        
        // 更新所有管理员的所有用户列表和在线用户列表
        broadcastAllUsersList();
        broadcastOnlineUsersList();
      } else {
        socket.send(JSON.stringify({ 
          success: false, 
          message: '用户不存在',
          action: 'admin-delete-user'
        }));
      }
      break;

    case 'admin-get-online-users':
      if (!socket.isAdmin) {
        socket.send(JSON.stringify({ 
          success: false, 
          message: '无权限执行此操作',
          action: 'admin-get-online-users'
        }));
        return;
      }
      sendOnlineUsersList(socket);
      break;

    case 'admin-get-all-users':
      if (!socket.isAdmin) {
        socket.send(JSON.stringify({ 
          success: false, 
          message: '无权限执行此操作',
          action: 'admin-get-all-users'
        }));
        return;
      }
      sendAllUsersList(socket);
      break;

    case 'admin-change-password':
      if (!socket.isAdmin) {
        socket.send(JSON.stringify({ 
          success: false, 
          message: '无权限执行此操作',
          action: 'admin-change-password'
        }));
        return;
      }
      
      if (data.newAdminPassword) {
        adminCredentials.password = data.newAdminPassword;
        saveAdminCredentials();
        socket.send(JSON.stringify({ 
          success: true, 
          message: '管理员密码修改成功',
          action: 'admin-change-password'
        }));
      } else {
        socket.send(JSON.stringify({ 
          success: false, 
          message: '新密码不能为空',
          action: 'admin-change-password'
        }));
      }
      break;

    default:
      if (data.type === 'message' && socket.user) {
        handleChatMessage(socket, data);
      }
      break;
  }
}

// 发送在线用户列表给指定管理员
function sendOnlineUsersList(adminSocket) {
  const onlineUsersList = Array.from(onlineUsers.keys());
  adminSocket.send(JSON.stringify({
    type: 'online-users-list',
    users: onlineUsersList,
    count: onlineUsersList.length
  }));
}

// 发送所有用户列表给指定管理员
function sendAllUsersList(adminSocket) {
  const allUsers = Object.keys(users);
  adminSocket.send(JSON.stringify({
    type: 'all-users-list',
    users: allUsers,
    count: allUsers.length
  }));
}

// 广播在线用户列表给所有管理员
function broadcastOnlineUsersList() {
  const onlineUsersList = Array.from(onlineUsers.keys());
  server.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.isAdmin) {
      client.send(JSON.stringify({
        type: 'online-users-list',
        users: onlineUsersList,
        count: onlineUsersList.length
      }));
    }
  });
}

// 广播所有用户列表给所有管理员
function broadcastAllUsersList() {
  const allUsers = Object.keys(users);
  server.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.isAdmin) {
      client.send(JSON.stringify({
        type: 'all-users-list',
        users: allUsers,
        count: allUsers.length
      }));
    }
  });
}

function handleChatMessage(socket, data) {
  const { content } = data;
  const sender = socket.user.username;
  const timestamp = Date.now();
  
  if (!content || typeof content !== 'string' || content.trim() === '') {
    return;
  }
  
  const messageObj = {
    type: 'message',
    sender: sender,
    content: content,
    timestamp: timestamp
  };
  
  let stored = false;
  
  // 广播公共消息（排除发送者）
  server.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client !== socket) {
      client.send(JSON.stringify(messageObj));
    }
  });
  
  // 存储为离线用户的离线消息
  const onlineUsernames = Array.from(onlineUsers.keys());
  
  Object.keys(users).forEach(username => {
    if (username === sender) return;
    
    if (!onlineUsernames.includes(username)) {
      if (!offlineMessages[username]) {
        offlineMessages[username] = [];
      }
      
      if (!offlineMessages[username].some(msg => 
        msg.sender === sender && 
        msg.content === content && 
        msg.timestamp === timestamp
      )) {
        offlineMessages[username].push(messageObj);
        stored = true;
      }
    }
  });
  
  if (stored) {
    saveOfflineMessages();
  }
  
  // 用户上线/下线时更新在线用户列表
  broadcastOnlineUsersList();
}

server.on('listening', () => {
  console.log(`服务器已启动: ws://0.0.0.0:8081`);
  console.log(`默认管理员账号: ${adminCredentials.username}, 密码: ${adminCredentials.password}`);
});
