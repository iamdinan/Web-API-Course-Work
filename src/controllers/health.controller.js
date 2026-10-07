function getHealth(req, res) {
  res.set('Cache-Control', 'no-cache').status(200).json({ status: 'ok' });
}

module.exports = { getHealth };
