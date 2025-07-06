const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { setupLogger } = require('../utils/logger');
const callsRouter = require('./calls');

const logger = setupLogger('api-routes');

// In-memory storage for users (would use a database in production)
const users = new Map();

// Available languages
const availableLanguages = {
  en: { code: 'en', name: 'English', voice: 'en-US-Neural2-F' },
  es: { code: 'es', name: 'Spanish', voice: 'es-ES-Neural2-A' },
  fr: { code: 'fr', name: 'French', voice: 'fr-FR-Neural2-A' },
  de: { code: 'de', name: 'German', voice: 'de-DE-Neural2-B' },
  it: { code: 'it', name: 'Italian', voice: 'it-IT-Neural2-A' },
  pt: { code: 'pt', name: 'Portuguese', voice: 'pt-PT-Neural2-A' },
  ja: { code: 'ja', name: 'Japanese', voice: 'ja-JP-Neural2-C' },
  ko: { code: 'ko', name: 'Korean', voice: 'ko-KR-Neural2-A' },
  zh: { code: 'zh', name: 'Chinese (Simplified)', voice: 'cmn-CN-Neural2-A' }
};

// GET /api/health - Health check
router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount calls router
router.use('/calls', callsRouter);

// GET /api/languages - Get available languages
router.get('/languages', (req, res) => {
  logger.debug('Fetching available languages');
  res.status(200).json({ languages: availableLanguages });
});

// GET /api/users/:userId - Get user by ID
router.get('/users/:userId', (req, res) => {
  const userId = req.params.userId;
  
  if (users.has(userId)) {
    logger.debug(`Fetching user: ${userId}`);
    res.status(200).json(users.get(userId));
  } else {
    logger.warn(`User not found: ${userId}`);
    res.status(404).json({ error: 'User not found' });
  }
});

// POST /api/users - Create a new user
router.post('/users', (req, res) => {
  const userData = req.body;
  
  // Validate required fields
  if (!userData.id || !userData.name || !userData.preferred_language) {
    return res.status(400).json({ error: 'Missing required user data' });
  }
  
  // Use the provided ID or generate a new one
  const userId = userData.id || uuidv4();
  
  // Create user object
  const user = {
    id: userId,
    name: userData.name,
    preferred_language: userData.preferred_language,
    created_at: new Date().toISOString()
  };
  
  // Store user in memory
  users.set(userId, user);
  
  logger.info(`Created new user: ${userId} (${userData.name})`);
  res.status(201).json(user);
});

// PUT /api/users/:userId - Update a user
router.put('/users/:userId', (req, res) => {
  const userId = req.params.userId;
  const updates = req.body;
  
  if (!users.has(userId)) {
    logger.warn(`Attempted to update non-existent user: ${userId}`);
    return res.status(404).json({ error: 'User not found' });
  }
  
  // Get existing user
  const user = users.get(userId);
  
  // Apply updates
  const updatedUser = {
    ...user,
    ...updates,
    updated_at: new Date().toISOString()
  };
  
  // Store updated user
  users.set(userId, updatedUser);
  
  logger.info(`Updated user: ${userId}`);
  res.status(200).json(updatedUser);
});

// DELETE /api/users/:userId - Delete a user
router.delete('/users/:userId', (req, res) => {
  const userId = req.params.userId;
  
  if (!users.has(userId)) {
    logger.warn(`Attempted to delete non-existent user: ${userId}`);
    return res.status(404).json({ error: 'User not found' });
  }
  
  // Remove user
  users.delete(userId);
  
  logger.info(`Deleted user: ${userId}`);
  res.status(204).send();
});

module.exports = router;
