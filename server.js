// server.js
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { solveQuiz } = require('./solver');

const app = express();

// JSON body parser with 1MB limit
app.use(bodyParser.json({ limit: '1mb' }));

// Return 400 for invalid JSON payloads
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid json' });
  }
  next(err);
});

// Read expected secret from env
const EXPECTED_SECRET = process.env.QUIZ_SECRET;

// timing-safe compare helper
function secretMatches(a, b) {
  try {
    if (!a || !b) return false;
    const A = Buffer.from(String(a));
    const B = Buffer.from(String(b));
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch (e) {
    return false;
  }
}

// Solver deadline (ms) - must be < 3 minutes (we use 170s = 170000ms)
const SOLVER_DEADLINE_MS = 170000;

app.post('/webhook', async (req, res) => {
  // Content-Type check (best effort)
  if (!req.is('application/json')) return res.status(400).json({ error: 'invalid json' });

  const { email, secret, url } = req.body || {};

  if (!email || !secret || !url) return res.status(400).json({ error: 'missing fields' });

  if (!EXPECTED_SECRET) {
    console.error('QUIZ_SECRET not set in environment');
    return res.status(500).json({ error: 'server misconfigured' });
  }

  if (!secretMatches(secret, EXPECTED_SECRET)) {
    return res.status(403).json({ error: 'invalid secret' });
  }

  // Immediately confirm receipt to the evaluator
  res.status(200).json({ status: 'accepted' });

  // Start solver in background, enforce overall timeout, and follow next URLs if provided
  (async () => {
    try {
      let remainingTime = SOLVER_DEADLINE_MS;
      let start = Date.now();

      // We'll allow the solver to follow at most a few rounds within the deadline.
      // Each round is run with Promise.race against the remaining time.
      let currentUrl = url;
      let round = 0;
      while (currentUrl && (Date.now() - start) < SOLVER_DEADLINE_MS && round < 10) {
        const timeSoFar = Date.now() - start;
        const timeLeft = Math.max(1000, SOLVER_DEADLINE_MS - timeSoFar); // at least 1s guard

        console.log(`Solver round ${round + 1} for ${currentUrl} (time left ${timeLeft} ms)`);

        // run one round with timeout
        const roundPromise = solveQuiz({ email, secret, url: currentUrl });
        const timeoutPromise = new Promise((_, rej) =>
          setTimeout(() => rej(new Error('solver round timeout')), timeLeft)
        );

        let reply;
        try {
          reply = await Promise.race([roundPromise, timeoutPromise]);
        } catch (err) {
          console.error('Solver round failed or timed out:', err);
          break;
        }

        // If the reply contains a new url, follow it; otherwise stop
        if (reply && typeof reply === 'object' && reply.url) {
          currentUrl = reply.url;
          console.log('Solver received next URL:', currentUrl);
        } else {
          currentUrl = null;
        }

        round++;
      }

      console.log('Solver background task finished');
    } catch (err) {
      console.error('Solver background error:', err);
    }
  })();
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
