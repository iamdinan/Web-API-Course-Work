const express = require('express');
const { rejectQueryParameters } = require('../../utils/public-request');

const router = express.Router();
router.get('/', rejectQueryParameters, (req, res) => {
  res.set('Cache-Control', 'no-cache').status(200).json({ status: 'ok' });
});

module.exports = router;
