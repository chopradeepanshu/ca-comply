const router = require('express').Router();
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// POST /api/bank-analysis/chat
router.post('/chat', async (req, res, next) => {
  const { message, context } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'AI chat is not configured. Please set ANTHROPIC_API_KEY.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `You are a financial analyst assistant for an Indian CA (Chartered Accountant) firm.
You analyze bank statement data and answer questions about it concisely.
Use Indian financial terminology and format amounts in Indian number system (e.g. ₹1,23,456).
Highlight anomalies, patterns, and insights clearly. Be direct and practical.`,
        messages: [
          {
            role: 'user',
            content: context
              ? `Here is the bank statement data:\n\n${context}\n\nQuestion: ${message}`
              : message,
          },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `Anthropic API error: ${response.status}`);
    }

    const data = await response.json();
    res.json({ reply: data.content[0].text });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
