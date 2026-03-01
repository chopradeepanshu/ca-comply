const router = require('express').Router();
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// POST /api/bank-analysis/chat
router.post('/chat', async (req, res, next) => {
  const { message, context } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'AI chat is not configured. Please set OPENAI_API_KEY.' });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 80,
        messages: [
          {
            role: 'system',
            content: 'You are a financial analyst for an Indian CA firm. Reply in max 30-40 words. Use ₹ and Indian number format (e.g. ₹1,23,456). Be direct and concise.',
          },
          {
            role: 'user',
            content: context
              ? `Bank data:\n${context}\n\nQuestion: ${message}`
              : message,
          },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    res.json({ reply: data.choices[0].message.content });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
