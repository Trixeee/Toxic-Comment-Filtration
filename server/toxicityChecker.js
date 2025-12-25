require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const toxicity = require('@tensorflow-models/toxicity');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');

const app = express();

app.use(cors({
  origin: config.corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS']
}));

const limiter = rateLimit(config.rateLimit);
app.use(limiter);

mongoose.connect(config.mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  retryWrites: true
})
.then(() => console.log('🟢 MongoDB connected'))
.catch(err => console.error('🔴 MongoDB connection error:', err));

const analysisSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true },
  results: { type: Array, required: true },
  threshold: { type: Number, default: 0.85 },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

const Analysis = mongoose.model('Analysis', analysisSchema);

let toxicityModel = null;
const loadModel = async (threshold = 0.85) => {
  if (!toxicityModel) {
    console.time('ModelLoadTime');
    toxicityModel = await toxicity.load(threshold);
    console.timeEnd('ModelLoadTime');
  }
  return toxicityModel;
};

app.post('/analyze', express.json(), async (req, res) => {
  try {
    const { text, threshold = 0.85 } = req.body;
    
    if (!text || text.trim().length < 3) {
      return res.status(400).json({ error: 'Text must be at least 3 characters' });
    }

    const model = await loadModel(threshold);
    const predictions = await model.classify([text.trim()]);
    
    const results = predictions
      .filter(p => p.results[0].match)
      .map(p => ({
        label: p.label,
        probability: p.results[0].probabilities[1]
      }));

    const analysis = await Analysis.create({ text, results, threshold });
    
    res.json({
      success: true,
      results,
      analysisId: analysis._id
    });
    
  } catch (error) {
    console.error('Analysis Error:', error);
    res.status(500).json({ 
      error: 'Analysis failed',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});

app.get('/history', async (req, res) => {
  try {
    const history = await Analysis.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .select('-__v');
      
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    dbState: mongoose.connection.readyState,
    modelLoaded: !!toxicityModel
  });
});

app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(config.port, () => {
  console.log(`🚀 Server running on port ${config.port}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    mongoose.connection.close(false, () => {
      console.log('🔴 Server and DB connections closed');
      process.exit(0);
    });
  });
});