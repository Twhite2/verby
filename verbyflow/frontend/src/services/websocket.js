/**
 * WebSocket service for VerbyFlow
 * Handles connection and reconnection to the WebSocket server
 */

/**
 * Creates a WebSocket connection with automatic reconnect capabilities
 * @param {string} url - The WebSocket URL to connect to
 * @param {Object} options - Configuration options
 * @returns {WebSocket} - The WebSocket instance
 */
export function createWebSocket(url, options = {}) {
  const {
    maxReconnectAttempts = 5,
    reconnectInterval = 3000,
    binaryType = 'blob', // Use blob for audio data
    callId = 'default-call',
    userId = 'anonymous-user'
  } = options;
  
  let reconnectAttempts = 0;
  let forceClosed = false;
  
  // ALWAYS connect directly to backend WebSocket server (no proxying)
  // This avoids issues with the development server's proxy for WebSockets
  const directBackendUrl = 'ws://localhost:3000/ws';
  
  // Build URL with query parameters
  const wsURL = new URL(directBackendUrl);
  wsURL.searchParams.append('callId', options.callId || callId);
  wsURL.searchParams.append('userId', options.userId || userId);
  
  // Log the connection attempt
  console.log(`[WS] Creating direct WebSocket connection: ${wsURL.toString()}`);
  
  // Create WebSocket with minimal options
  // The simple approach often works better with WebSockets
  const ws = new WebSocket(wsURL.toString());
  ws.binaryType = binaryType;
  
  // Log connection open for debugging
  ws.addEventListener('open', () => {
    console.log('[WS] Connection established successfully');
    reconnectAttempts = 0; // Reset reconnect attempts on successful connection
  });
  
  // Store the original close method
  const originalClose = ws.close;
  
  // Override the close method to mark intentional closes
  ws.close = function(code = 1000, reason) {
    forceClosed = true;
    return originalClose.call(this, code, reason);
  };
  
  // Handle connection errors with improved logging
  ws.addEventListener('error', (error) => {
    console.error('[WS ERROR]', error.message || 'WebSocket connection error');
  });
  
  // Handle disconnections and reconnect if necessary
  ws.addEventListener('close', (event) => {
    // Log close event with code and reason
    const reason = event.reason ? ` (${event.reason})` : '';
    console.log(`[WS] Connection closed with code ${event.code}${reason}`);
    
    if (forceClosed) {
      console.log('[WS] Connection closed intentionally');
      return;
    }
    
    // Standard close codes (don't try to reconnect for normal closures)
    if (event.code === 1000) {
      console.log('[WS] Normal closure - not attempting to reconnect');
      return;
    }
    
    if (reconnectAttempts < maxReconnectAttempts) {
      console.log(`[WS] Attempting to reconnect (${reconnectAttempts + 1}/${maxReconnectAttempts})...`);
      
      setTimeout(() => {
        reconnectAttempts++;
        
        try {
          // Create a new WebSocket instance with the same URL and options
          const newWs = createWebSocket(url, options);
          
          // Copy over event listeners from the old instance
          // Note: This is a simplification and may not capture all event listeners
          if (ws.onmessage) newWs.onmessage = ws.onmessage;
          if (ws.onopen) newWs.onopen = ws.onopen;
          if (ws.onerror) newWs.onerror = ws.onerror;
          if (ws.onclose) newWs.onclose = ws.onclose;
          
          // Replace the old instance with the new one
          Object.assign(ws, newWs);
        } catch (reconnectError) {
          console.error('[WS] Reconnection attempt failed:', reconnectError.message);
        }
      }, reconnectInterval);
    } else {
      console.error('[WS] Max reconnect attempts reached. Giving up.');
    }
  });
  
  return ws;
}

/**
 * Sends data through WebSocket with binary support
 * @param {WebSocket} ws - The WebSocket instance
 * @param {Object|ArrayBuffer|Blob} data - The data to send
 */
export function sendWebSocketMessage(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('[WS] Cannot send message - WebSocket not open');
    return;
  }
  
  try {
    if (data instanceof ArrayBuffer || data instanceof Blob) {
      // Send binary data directly
      ws.send(data);
    } else if (typeof data === 'object') {
      // Convert objects to JSON strings
      ws.send(JSON.stringify(data));
    } else {
      // Send other data types as-is
      ws.send(data);
    }
  } catch (error) {
    console.error('[WS] Error sending message:', error);
  }
}

/**
 * Check if the WebSocket is in a connected state
 * @param {WebSocket} ws - The WebSocket instance to check
 * @returns {boolean} - Whether the WebSocket is connected
 */
export function isWebSocketConnected(ws) {
  return ws && ws.readyState === WebSocket.OPEN;
}
