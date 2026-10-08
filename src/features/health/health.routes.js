const express = require('express');

const router = express.Router();
router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache').status(200).json({ status: 'ok' });
});

module.exports = router;
