const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { setupLogger } = require('../utils/logger');

const logger = setupLogger('calls-api');

// In-memory storage for calls
const calls = new Map();

// GET /api/calls - Get all calls
router.get('/', (req, res) => {
  logger.debug('Fetching all calls');
  const callList = Array.from(calls.values());
  res.status(200).json({ calls: callList });
});

// GET /api/calls/:callId - Get call by ID
router.get('/:callId', (req, res) => {
  try {
    const callId = req.params.callId;
    
    if (!callId) {
      logger.warn('Attempted to fetch call without a valid ID');
      return res.status(400).json({ error: 'Invalid call ID' });
    }
    
    if (calls.has(callId)) {
      logger.debug(`Fetching call: ${callId}`);
      return res.status(200).json(calls.get(callId));
    } else {
      logger.warn(`Call not found: ${callId}`);
      return res.status(404).json({ error: 'Call not found' });
    }
  } catch (error) {
    logger.error(`Error retrieving call: ${error.message}`, { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/calls - Create a new call
router.post('/', (req, res) => {
  try {
    // Generate a new unique call ID
    const callId = uuidv4();
    
    // Extract creator ID from request body
    const { creator_id } = req.body;
    
    // Validate required fields
    if (!creator_id) {
      logger.warn('Attempted to create call without creator_id');
      return res.status(400).json({ error: 'Missing creator_id' });
    }
    
    // Create call object
    const call = {
      id: callId,
      creator_id,
      participants: [creator_id], // Creator is the first participant
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      active: true
    };
    
    // Store call in memory
    calls.set(callId, call);
    
    logger.info(`Created new call: ${callId} by user ${creator_id}`);
    return res.status(201).json(call);
  } catch (error) {
    logger.error(`Error creating call: ${error.message}`, { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/calls/:callId - Update a call
router.put('/:callId', (req, res) => {
  const callId = req.params.callId;
  const updates = req.body;
  
  if (!calls.has(callId)) {
    logger.warn(`Attempted to update non-existent call: ${callId}`);
    return res.status(404).json({ error: 'Call not found' });
  }
  
  // Get existing call
  const call = calls.get(callId);
  
  // Apply updates
  const updatedCall = {
    ...call,
    ...updates,
    updated_at: new Date().toISOString()
  };
  
  // Store updated call
  calls.set(callId, updatedCall);
  
  logger.info(`Updated call: ${callId}`);
  res.status(200).json(updatedCall);
});

// POST /api/calls/:callId/join - Join a call
router.post('/:callId/join', (req, res) => {
  const callId = req.params.callId;
  const { user_id } = req.body;
  
  if (!user_id) {
    logger.warn('Attempted to join call without user_id');
    return res.status(400).json({ error: 'Missing user_id' });
  }
  
  if (!calls.has(callId)) {
    logger.warn(`Attempted to join non-existent call: ${callId}`);
    return res.status(404).json({ error: 'Call not found' });
  }
  
  // Get existing call
  const call = calls.get(callId);
  
  // Add participant if not already in the call
  if (!call.participants.includes(user_id)) {
    call.participants.push(user_id);
    call.updated_at = new Date().toISOString();
    calls.set(callId, call);
    logger.info(`User ${user_id} joined call: ${callId}`);
  }
  
  res.status(200).json(call);
});

// POST /api/calls/:callId/leave - Leave a call
router.post('/:callId/leave', (req, res) => {
  const callId = req.params.callId;
  const { user_id } = req.body;
  
  if (!user_id) {
    logger.warn('Attempted to leave call without user_id');
    return res.status(400).json({ error: 'Missing user_id' });
  }
  
  if (!calls.has(callId)) {
    logger.warn(`Attempted to leave non-existent call: ${callId}`);
    return res.status(404).json({ error: 'Call not found' });
  }
  
  // Get existing call
  const call = calls.get(callId);
  
  // Remove participant
  call.participants = call.participants.filter(id => id !== user_id);
  call.updated_at = new Date().toISOString();
  
  // If no participants left, mark call as inactive
  if (call.participants.length === 0) {
    call.active = false;
  }
  
  // Update call
  calls.set(callId, call);
  logger.info(`User ${user_id} left call: ${callId}`);
  
  res.status(200).json(call);
});

// DELETE /api/calls/:callId - End a call
router.delete('/:callId', (req, res) => {
  const callId = req.params.callId;
  
  if (!calls.has(callId)) {
    logger.warn(`Attempted to delete non-existent call: ${callId}`);
    return res.status(404).json({ error: 'Call not found' });
  }
  
  // Get existing call and mark as inactive
  const call = calls.get(callId);
  call.active = false;
  call.updated_at = new Date().toISOString();
  calls.set(callId, call);
  
  logger.info(`Call ended: ${callId}`);
  res.status(200).json(call);
});

module.exports = router;
