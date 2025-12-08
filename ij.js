class EMRIGHS {
    constructor() {
        // Add new properties
        this.groups = [];
        this.selectedGroup = null;
        this.forwardingMessage = null;
        
        // Initialize groups
        this.initializeGroups();
    }

    // Initialize groups
    initializeGroups() {
        if (this.socket && this.currentUser) {
            this.loadUserGroups();
        }
    }

    // Load user's groups
    loadUserGroups() {
        if (!this.socket) return;
        
        this.socket.emit('get my groups', (response) => {
            if (response && response.groups) {
                this.groups = response.groups;
                this.renderGroups();
            }
        });
    }

    // Render groups in sidebar
    renderGroups() {
        const $groupsList = $('#groupsList');
        if (!$groupsList.length) return;
        
        if (this.groups.length === 0) {
            $groupsList.html(`
                <div style="text-align: center; padding: 20px; color: var(--text-muted);">
                    <i class="fas fa-users" style="opacity: 0.5; margin-bottom: 8px;"></i>
                    <div>No groups yet</div>
                </div>
            `);
            return;
        }
        
        const groupsHtml = this.groups.map(group => this.createGroupElement(group)).join('');
        $groupsList.html(groupsHtml);
    }

    // Create group element for sidebar
    createGroupElement(group) {
        return `
            <li class="chat-item group-item" data-group-id="${group.group_id}" data-type="group">
                <div class="chat-avatar">
                    <div class="avatar" style="background: linear-gradient(135deg, #a78bfa, #8b5cf6);">
                        <i class="fas fa-users"></i>
                    </div>
                </div>
                <div class="chat-info">
                    <div class="chat-header">
                        <span class="chat-name">${group.group_name}</span>
                        <span style="font-size: 0.7rem; color: var(--text-muted);">
                            ${group.memberCount || 0} members
                        </span>
                    </div>
                    <div class="chat-last-message">
                        Created by ${group.created_by}
                    </div>
                </div>
            </li>
        `;
    }

    // Select group chat
    selectGroup(groupId) {
        this.currentChat = groupId;
        this.selectedGroup = this.groups.find(g => g.group_id === groupId);
        this.selectChat(groupId, 'group');
    }

    // Modified selectChat method to handle groups
    selectChat(chatId, type = 'user') {
        console.log('Selecting chat:', chatId, 'Type:', type);
        
        if (type === 'group') {
            this.currentChat = chatId;
            this.updateGroupHeader(chatId);
        } else {
            this.currentChat = chatId;
            this.updateChatHeader(chatId);
        }
        
        this.messageOffset = 0;
        this.hasMoreMessages = true;
        this.isLoadingMessages = false;
        this.autoScrollEnabled = true;
        this.initialLoad = true;
        
        $('#welcomeScreen').hide();
        $('#chatHeader').show();
        $('#messagesContainer').show();
        $('#messageInputContainer').show();
        
        this.loadMessages(chatId, type);
        
        // Update active state
        $('.chat-item').removeClass('active');
        if (type === 'group') {
            $(`.chat-item[data-group-id="${chatId}"]`).addClass('active');
        } else if (chatId === 'broadcast') {
            $('.broadcast-item').addClass('active');
        } else {
            $(`.chat-item[data-username="${chatId}"]`).addClass('active');
        }
    }

    // Update group header
    updateGroupHeader(groupId) {
        const $partnerName = $('#chatPartnerName');
        const $partnerStatus = $('#partnerStatus');
        const $partnerAvatar = $('#partnerAvatar');
        
        const group = this.groups.find(g => g.group_id === groupId);
        if (group) {
            $partnerName.text(group.group_name);
            $partnerStatus.html(`<i class="fas fa-users"></i> ${group.memberCount || 0} members`);
            $partnerAvatar.html('<i class="fas fa-users"></i>').css('background', 'linear-gradient(135deg, #a78bfa, #8b5cf6)');
        }
    }

    // Modified loadMessages for groups
    loadMessages(chatId, type = 'user') {
        console.log('Loading messages for:', chatId, 'Type:', type);
        const $messagesScroll = $('#messagesScroll');
        if (!$messagesScroll.length) return;
        
        this.messageOffset = 0;
        this.hasMoreMessages = true;
        this.isLoadingMessages = false;
        this.initialLoad = true;
        
        $messagesScroll.html('<div class="loading"><div class="spinner"></div></div>');
        $messagesScroll.scrollTop(0);
        
        if (type === 'group') {
            console.log('Requesting group history:', chatId);
            this.socket.emit('get group history', { 
                groupId: chatId,
                offset: this.messageOffset, 
                limit: this.MESSAGES_PER_LOAD 
            }, (response) => {
                if (response && response.messages) {
                    this.renderMessages(response.messages, false);
                }
            });
        } else if (chatId === 'broadcast') {
            console.log('Requesting broadcast history');
            this.socket.emit('get broadcast history', { 
                offset: this.messageOffset, 
                limit: this.MESSAGES_PER_LOAD 
            });
        } else {
            console.log('Requesting private history:', chatId);
            this.socket.emit('get history', { 
                withUser: chatId,
                offset: this.messageOffset,
                limit: this.MESSAGES_PER_LOAD
            });
        }
    }

    // Create group message element
    createGroupMessageElement(msg) {
        const isSender = msg.sender === this.currentUser;
        const time = this.formatTimestamp(msg.timestamp);
        
        let forwardedBadge = '';
        if (msg.is_forwarded) {
            forwardedBadge = `
                <div class="message-forwarded">
                    <i class="fas fa-share"></i>
                    Forwarded from ${msg.original_sender}
                </div>
            `;
        }
        
        return $(`
            <div class="message ${isSender ? 'message-sent' : 'message-received'} group-message"
                 data-message-id="${msg.id}"
                 data-sender="${msg.sender}"
                 data-timestamp="${msg.timestamp}">
                <div class="message-header">
                    <span class="message-sender">${msg.sender}</span>
                    <span class="message-time">${time}</span>
                </div>
                ${forwardedBadge}
                <div class="message-content">${this.escapeHtml(msg.message)}</div>
            </div>
        `)[0];
    }

    // Send message to group
    async sendGroupMessage() {
        const $input = $('#messageInput');
        if (!$input.length || !this.currentChat || !this.selectedGroup) return;
        
        const message = $input.val().trim();
        if (!message) return;
        
        try {
            $input.val('');
            this.autoResizeTextarea();
            
            const optimisticMessage = {
                groupId: this.currentChat,
                sender: this.currentUser,
                message: message,
                timestamp: new Date().toISOString(),
                isOptimistic: true
            };
            
            const messageElement = this.createGroupMessageElement(optimisticMessage);
            const $messagesScroll = $('#messagesScroll');
            if ($messagesScroll.length) {
                $messagesScroll.append(messageElement);
                setTimeout(() => {
                    this.forceScrollToBottom();
                }, 50);
            }
            
            this.socket.emit('group message', {
                groupId: this.currentChat,
                message: message
            }, (response) => {
                if (response && response.error) {
                    this.showNotification(response.error, 'error');
                }
            });
            
        } catch (error) {
            this.showNotification('Failed to send message', 'error');
        }
    }

    // Show create group modal
    showCreateGroupModal() {
        const $modal = $('#createGroupModal');
        const $availableUsers = $('#availableUsers');
        
        // Populate available users
        const availableUsersHtml = this.users
            .filter(user => user.username !== this.currentUser)
            .map(user => `
                <div class="user-checkbox">
                    <input type="checkbox" 
                           id="user_${user.username}" 
                           value="${user.username}"
                           class="user-select-checkbox">
                    <label for="user_${user.username}" style="cursor: pointer;">
                        ${user.username}
                        ${user.is_online ? '<span style="color: var(--accent); font-size: 0.8rem;">●</span>' : ''}
                    </label>
                </div>
            `).join('');
        
        $availableUsers.html(availableUsersHtml);
        $('#selectedMembers').empty();
        $('#groupNameInput').val('');
        
        $modal.css('display', 'flex');
    }

    // Create new group
    createGroup() {
        const groupName = $('#groupNameInput').val().trim();
        if (!groupName) {
            this.showNotification('Please enter a group name', 'error');
            return;
        }
        
        const selectedUsers = [];
        $('.user-select-checkbox:checked').each(function() {
            selectedUsers.push($(this).val());
        });
        
        if (selectedUsers.length === 0) {
            this.showNotification('Please select at least one member', 'error');
            return;
        }
        
        this.socket.emit('create group', {
            groupName: groupName,
            members: selectedUsers
        }, (response) => {
            if (response && response.success) {
                this.showNotification('Group created successfully', 'success');
                $('#createGroupModal').hide();
                this.loadUserGroups();
            } else {
                this.showNotification(response.error || 'Failed to create group', 'error');
            }
        });
    }

    // Show forward modal
    showForwardModal(message) {
        this.forwardingMessage = message;
        const $modal = $('#forwardModal');
        const $preview = $('#forwardMessagePreview');
        
        // Show message preview
        const previewHtml = `
            <div style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 4px;">
                From: ${message.sender}
            </div>
            <div style="background: var(--bg-primary); padding: 12px; border-radius: var(--radius-md); border: 1px solid var(--border-light);">
                ${message.message ? this.escapeHtml(message.message) : 'File: ' + (message.filename || 'Unknown')}
            </div>
        `;
        $preview.html(previewHtml);
        
        // Populate recipients
        this.updateForwardRecipients('users');
        
        $modal.css('display', 'flex');
    }

    // Update forward recipients list
    updateForwardRecipients(type) {
        const $recipientsList = $('#forwardRecipients');
        let recipientsHtml = '';
        
        if (type === 'users') {
            recipientsHtml = this.users
                .filter(user => user.username !== this.currentUser)
                .map(user => `
                    <div class="user-checkbox">
                        <input type="checkbox" 
                               id="forward_user_${user.username}" 
                               value="${user.username}"
                               data-type="user"
                               class="forward-select-checkbox">
                        <label for="forward_user_${user.username}" style="cursor: pointer;">
                            ${user.username}
                            ${user.is_online ? '<span style="color: var(--accent); font-size: 0.8rem;">●</span>' : ''}
                        </label>
                    </div>
                `).join('');
        } else {
            recipientsHtml = this.groups.map(group => `
                <div class="user-checkbox">
                    <input type="checkbox" 
                           id="forward_group_${group.group_id}" 
                           value="${group.group_id}"
                           data-type="group"
                           class="forward-select-checkbox">
                    <label for="forward_group_${group.group_id}" style="cursor: pointer;">
                        <i class="fas fa-users"></i> ${group.group_name}
                        <span style="font-size: 0.8rem; color: var(--text-muted);">
                            (${group.memberCount || 0} members)
                        </span>
                    </label>
                </div>
            `).join('');
        }
        
        $recipientsList.html(recipientsHtml);
        
        // Update tab buttons
        $('.btn-tab').removeClass('active');
        $(`.btn-tab[data-type="${type}"]`).addClass('active');
    }

    // Forward message
    forwardMessage() {
        if (!this.forwardingMessage) return;
        
        const selectedRecipients = [];
        const recipientType = $('.btn-tab.active').data('type');
        
        $(`.forward-select-checkbox:checked`).each(function() {
            selectedRecipients.push({
                id: $(this).val(),
                type: $(this).data('type')
            });
        });
        
        if (selectedRecipients.length === 0) {
            this.showNotification('Please select at least one recipient', 'error');
            return;
        }
        
        this.socket.emit('forward message', {
            originalMessage: this.forwardingMessage,
            recipients: selectedRecipients.map(r => r.id),
            recipientType: recipientType
        }, (response) => {
            if (response && response.success) {
                this.showNotification('Message forwarded', 'success');
                $('#forwardModal').hide();
                this.forwardingMessage = null;
            } else {
                this.showNotification(response.error || 'Failed to forward message', 'error');
            }
        });
    }

    // Show group info modal
    showGroupInfo(groupId) {
        const $modal = $('#groupInfoModal');
        const group = this.groups.find(g => g.group_id === groupId);
        
        if (!group) return;
        
        $('#groupInfoName').text(group.group_name);
        $('#groupInfoCreator').text(`Created by ${group.created_by}`);
        
        // Check if current user is creator
        const isCreator = group.created_by === this.currentUser;
        $('#groupAdminActions').toggle(isCreator);
        
        // Load members
        this.socket.emit('get group members', { groupId: groupId }, (response) => {
            if (response && response.members) {
                $('#memberCount').text(response.members.length);
                
                const membersHtml = response.members.map(member => `
                    <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px; border-bottom: 1px solid var(--border-light);">
                        <div>
                            <span>${member.username}</span>
                            ${member.is_online ? '<span style="color: var(--accent); font-size: 0.8rem;"> ● Online</span>' : 
                                `<span style="color: var(--text-muted); font-size: 0.8rem;"> Last seen ${this.formatLastSeen(member.last_seen)}</span>`}
                        </div>
                        <div style="font-size: 0.8rem; color: var(--text-muted);">
                            Joined ${new Date(member.joined_at).toLocaleDateString()}
                        </div>
                    </div>
                `).join('');
                
                $('#groupMembersList').html(membersHtml);
            }
        });
        
        $modal.css('display', 'flex');
    }

    // Setup new event listeners
    setupGroupEventListeners() {
        // Create group button
        $('#createGroupBtn').on('click', () => this.showCreateGroupModal());
        
        // Close group modal
        $('#closeGroupModal').on('click', () => $('#createGroupModal').hide());
        $('#cancelGroupBtn').on('click', () => $('#createGroupModal').hide());
        
        // Save group
        $('#saveGroupBtn').on('click', () => this.createGroup());
        
        // Group item click
        $('#groupsList').on('click', '.group-item', (e) => {
            const groupId = $(e.currentTarget).data('group-id');
            if (groupId) {
                this.selectGroup(groupId);
                $('#sidebar').removeClass('active');
            }
        });
        
        // User selection in group creation
        $('#availableUsers').on('change', '.user-select-checkbox', (e) => {
            const username = $(e.target).val();
            const isChecked = $(e.target).is(':checked');
            
            if (isChecked) {
                const tag = $(`
                    <span class="member-tag">
                        ${username}
                        <span class="remove-member" data-user="${username}">&times;</span>
                    </span>
                `);
                $('#selectedMembers').append(tag);
            } else {
                $(`.remove-member[data-user="${username}"]`).parent().remove();
            }
        });
        
        // Remove member tag
        $('#selectedMembers').on('click', '.remove-member', (e) => {
            const username = $(e.target).data('user');
            $(`.user-select-checkbox[value="${username}"]`).prop('checked', false);
            $(e.target).parent().remove();
        });
        
        // Forward message modal
        $('#closeForwardModal').on('click', () => {
            $('#forwardModal').hide();
            this.forwardingMessage = null;
        });
        
        $('#cancelForwardBtn').on('click', () => {
            $('#forwardModal').hide();
            this.forwardingMessage = null;
        });
        
        // Forward tab switching
        $('.btn-tab').on('click', (e) => {
            const type = $(e.target).data('type');
            this.updateForwardRecipients(type);
        });
        
        // Send forward
        $('#sendForwardBtn').on('click', () => this.forwardMessage());
        
        // Message right-click for context menu
        $(document).on('contextmenu', '.message:not(.message-system)', (e) => {
            e.preventDefault();
            this.showMessageContextMenu(e);
        });
        
        // Close context menu on click elsewhere
        $(document).on('click', () => {
            $('#messageContextMenu').hide();
        });
    }

    // Show message context menu
    showMessageContextMenu(e) {
        const $message = $(e.currentTarget);
        const messageId = $message.data('message-id');
        const sender = $message.data('sender');
        
        // Position menu at click location
        $('#messageContextMenu')
            .css({
                left: e.pageX,
                top: e.pageY,
                display: 'block'
            })
            .data('message-element', $message);
        
        // Store message data for context actions
        const messageData = {
            id: messageId,
            sender: sender,
            element: $message
        };
        
        $('#messageContextMenu').data('message', messageData);
    }

    // Handle message actions
    handleMessageAction(action) {
        const messageData = $('#messageContextMenu').data('message');
        if (!messageData) return;
        
        const $message = messageData.element;
        
        switch(action) {
            case 'reply':
                this.replyToMessage(messageData);
                break;
            case 'forward':
                const message = this.getMessageData($message);
                this.showForwardModal(message);
                break;
            case 'delete':
                this.deleteMessage(messageData);
                break;
            case 'copy':
                this.copyMessageText($message);
                break;
        }
        
        $('#messageContextMenu').hide();
    }

    // Get message data from element
    getMessageData($message) {
        return {
            id: $message.data('message-id'),
            sender: $message.data('sender'),
            message: $message.find('.message-content').text(),
            timestamp: $message.data('timestamp')
        };
    }

    // Copy message text
    copyMessageText($message) {
        const text = $message.find('.message-content').text();
        navigator.clipboard.writeText(text).then(() => {
            this.showNotification('Message copied to clipboard', 'success');
        });
    }

    // Setup context menu actions
    setupContextMenuListeners() {
        $(document).on('click', '.context-menu-item', (e) => {
            const action = $(e.target).data('action');
            this.handleMessageAction(action);
        });
    }

    // Socket listeners for group events
    setupGroupSocketListeners() {
        // Group created
        this.socket.on('group created', (data) => {
            this.showNotification(`Added to group: ${data.groupName}`, 'info');
            this.loadUserGroups();
        });
        
        // Group message received
        this.socket.on('group message', (msg) => {
            console.log('Received group message:', msg);
            
            // Check if this group is currently open
            const shouldDisplay = this.currentChat === msg.groupId;
            
            if (shouldDisplay) {
                const messageElement = this.createGroupMessageElement(msg);
                const $messagesScroll = $('#messagesScroll');
                if ($messagesScroll.length) {
                    $messagesScroll.append(messageElement);
                    
                    const isUserAtBottom = this.isUserNearBottom();
                    const isFromCurrentUser = msg.sender === this.currentUser;
                    
                    if (isUserAtBottom || isFromCurrentUser) {
                        setTimeout(() => {
                            this.forceScrollToBottom();
                        }, 50);
                    }
                }
            } else {
                // Show notification for group messages in other groups
                const group = this.groups.find(g => g.group_id === msg.groupId);
                if (group) {
                    this.showNotification(`New message in ${group.group_name} from ${msg.sender}`, 'info');
                }
            }
        });
        
        // Group members updated
        this.socket.on('group members updated', (data) => {
            if (this.currentChat === data.groupId) {
                this.showNotification(`${data.addedBy} added ${data.addedMembers.length} new member(s) to the group`, 'info');
            }
        });
        
        // Group deleted
        this.socket.on('group deleted', (data) => {
            if (this.currentChat === data.groupId) {
                this.showNotification('This group has been deleted', 'warning');
                this.selectChat('broadcast');
            }
        });
    }

    // Initialize everything
    initializeApp() {
        // Existing initialization...
        this.checkAuthentication();
        this.initializeSocket();
        this.setupEventListeners();
        this.applyTheme();
        this.setupEmojiPicker();
        this.setupFileUpload();
        this.setupPasteHandler();
        
        // New group-related initialization
        this.setupGroupEventListeners();
        this.setupContextMenuListeners();
        
        // Initialize groups after socket is ready
        if (this.socket) {
            this.setupGroupSocketListeners();
            this.socket.on('connect', () => {
                this.loadUserGroups();
            });
        }
    }
}

// Update the send message method to handle group messages
EMRIGHS.prototype.sendMessage = async function() {
    const $input = $('#messageInput');
    if (!$input.length || !this.currentChat) return;
    
    const message = $input.val().trim();
    if (!message) return;
    
    try {
        $input.val('');
        this.autoResizeTextarea();
        
        // Check if current chat is a group
        const isGroup = this.groups.some(g => g.group_id === this.currentChat);
        
        if (isGroup) {
            // Use group message sending
            await this.sendGroupMessage();
        } else {
            // Original private/broadcast message sending logic
            const optimisticMessage = {
                sender: this.currentUser,
                message: message,
                timestamp: new Date().toISOString(),
                isOptimistic: true
            };
            
            const messageElement = this.createMessageElement(optimisticMessage);
            const $messagesScroll = $('#messagesScroll');
            if ($messagesScroll.length) {
                $messagesScroll.append(messageElement);
                setTimeout(() => {
                    this.forceScrollToBottom();
                }, 50);
            }
            
            if (this.currentChat === 'broadcast') {
                this.socket.emit('broadcast message', message);
            } else {
                this.socket.emit('private message', {
                    sender: this.currentUser,
                    recipient: this.currentChat,
                    message: message
                });
            }
        }
        
    } catch (error) {
        this.showNotification('Failed to send message', 'error');
    }
};