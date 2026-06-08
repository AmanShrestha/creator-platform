const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const stripe = require('stripe');
const paypal = require('@paypal/checkout-server-sdk');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5000',
    process.env.FRONTEND_URL || 'https://localhost:3000'
  ]
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Health check endpoint (Render needs this)
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'UP', timestamp: new Date() });
});

app.get('/', (req, res) => {
  res.json({ 
    message: 'Creator Monetization Platform API',
    status: 'running',
    version: '1.0.0'
  });
});

// Initialize Stripe
const stripeClient = stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy');

// Initialize PayPal
let paypalClient = null;
if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) {
  const environment = process.env.PAYPAL_MODE === 'live' 
    ? new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
    : new paypal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);
  paypalClient = new paypal.core.PayPalHttpClient(environment);
}

// Multer for file uploads
const upload = multer({ 
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, process.env.UPLOAD_DIR || '/tmp/uploads/');
    },
    filename: (req, file, cb) => {
      cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '-'));
    }
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['application/pdf', 'video/mp4', 'image/jpeg', 'image/png', 'application/zip'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

// In-memory database (perfect for MVP)
const creators = new Map();
const products = new Map();
const subscriptions = new Map();
const emails = new Map();
const bookings = new Map();
const payments = new Map();

let productIdCounter = 1;
let creatorIdCounter = 1;
let subscriptionIdCounter = 1;
let emailIdCounter = 1;
let bookingIdCounter = 1;
let paymentIdCounter = 1;

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production-12345';

// Verify JWT
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token', details: err.message });
  }
};

// ============ AUTH ROUTES ============

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, bio, website } = req.body;
    
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (Array.from(creators.values()).find(c => c.email === email)) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const creatorId = `creator_${creatorIdCounter++}`;
    
    const creator = {
      id: creatorId,
      email,
      password: hashedPassword,
      name,
      bio: bio || '',
      website: website || '',
      storeName: name,
      storeImage: '',
      socialLinks: {},
      createdAt: new Date(),
      products: [],
      subscriptions: [],
      emails: [],
      bookings: [],
      payoutSettings: {
        stripeConnectId: null,
        paypalEmail: null
      },
      analytics: {
        totalRevenue: 0,
        totalCustomers: 0,
        totalProducts: 0,
        totalSales: 0
      }
    };
    
    creators.set(creatorId, creator);
    
    const token = jwt.sign({ id: creatorId, email }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ 
      token, 
      creator: { ...creator, password: undefined } 
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const creator = Array.from(creators.values()).find(c => c.email === email);
    if (!creator) return res.status(400).json({ error: 'Creator not found' });
    
    const validPassword = await bcrypt.compare(password, creator.password);
    if (!validPassword) return res.status(400).json({ error: 'Invalid password' });
    
    const token = jwt.sign({ id: creator.id, email: creator.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, creator: { ...creator, password: undefined } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/creator/profile', verifyToken, (req, res) => {
  try {
    const creator = creators.get(req.user.id);
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    res.json({ ...creator, password: undefined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/creator/profile', verifyToken, (req, res) => {
  try {
    const creator = creators.get(req.user.id);
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    
    const { name, bio, website, storeName, storeImage, socialLinks } = req.body;
    
    if (name) creator.name = name;
    if (bio) creator.bio = bio;
    if (website) creator.website = website;
    if (storeName) creator.storeName = storeName;
    if (storeImage) creator.storeImage = storeImage;
    if (socialLinks) creator.socialLinks = { ...creator.socialLinks, ...socialLinks };
    
    creators.set(req.user.id, creator);
    res.json({ ...creator, password: undefined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ PRODUCT ROUTES ============

app.post('/api/products', verifyToken, upload.single('file'), async (req, res) => {
  try {
    const { name, description, price, type, category, imageUrl } = req.body;
    const creator = creators.get(req.user.id);
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    
    const productId = `product_${productIdCounter++}`;
    const product = {
      id: productId,
      creatorId: req.user.id,
      name,
      description: description || '',
      price: parseFloat(price) || 0,
      type: type || 'course',
      category: category || 'general',
      imageUrl: imageUrl || '',
      fileUrl: req.file ? `/uploads/${req.file.filename}` : null,
      createdAt: new Date(),
      sales: 0,
      revenue: 0,
      status: 'active'
    };
    
    products.set(productId, product);
    creator.products.push(productId);
    creator.analytics.totalProducts = creator.products.length;
    creators.set(req.user.id, creator);
    
    res.status(201).json(product);
  } catch (err) {
    console.error('Product creation error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products', verifyToken, (req, res) => {
  try {
    const creator = creators.get(req.user.id);
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    
    const creatorProducts = creator.products
      .map(id => products.get(id))
      .filter(Boolean);
    res.json(creatorProducts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/store/:creatorId', (req, res) => {
  try {
    const creator = creators.get(req.params.creatorId);
    if (!creator) return res.status(404).json({ error: 'Store not found' });
    
    const storeProducts = creator.products
      .map(id => {
        const product = products.get(id);
        return product ? { ...product, fileUrl: undefined } : null;
      })
      .filter(Boolean);
    
    res.json({
      creatorId: creator.id,
      name: creator.storeName,
      image: creator.storeImage,
      bio: creator.bio,
      website: creator.website,
      products: storeProducts,
      socialLinks: creator.socialLinks,
      analytics: creator.analytics
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ MEMBERSHIP ROUTES ============

app.post('/api/memberships', verifyToken, (req, res) => {
  try {
    const { name, description, price, billingCycle, features } = req.body;
    const creator = creators.get(req.user.id);
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    
    const subscriptionId = `sub_${subscriptionIdCounter++}`;
    const membership = {
      id: subscriptionId,
      creatorId: req.user.id,
      name,
      description: description || '',
      price: parseFloat(price) || 0,
      billingCycle: billingCycle || 'monthly',
      features: Array.isArray(features) ? features : [features || ''],
      members: [],
      createdAt: new Date(),
      totalRevenue: 0
    };
    
    subscriptions.set(subscriptionId, membership);
    creator.subscriptions.push(subscriptionId);
    creators.set(req.user.id, creator);
    
    res.status(201).json(membership);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/memberships', verifyToken, (req, res) => {
  try {
    const creator = creators.get(req.user.id);
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    
    const membershipData = creator.subscriptions
      .map(id => subscriptions.get(id))
      .filter(Boolean);
    res.json(membershipData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ EMAIL ROUTES ============

app.post('/api/emails', verifyToken, (req, res) => {
  try {
    const { subject, content, recipients, sendAt } = req.body;
    const creator = creators.get(req.user.id);
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    
    const emailId = `email_${emailIdCounter++}`;
    const campaign = {
      id: emailId,
      creatorId: req.user.id,
      subject,
      content: content || '',
      recipients: Array.isArray(recipients) ? recipients : [recipients || ''],
      sendAt: new Date(sendAt || Date.now()),
      status: 'scheduled',
      openRate: 0,
      clickRate: 0,
      createdAt: new Date()
    };
    
    emails.set(emailId, campaign);
    creator.emails.push(emailId);
    creators.set(req.user.id, creator);
    
    res.status(201).json(campaign);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/emails', verifyToken, (req, res) => {
  try {
    const creator = creators.get(req.user.id);
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    
    const campaigns = creator.emails
      .map(id => emails.get(id))
      .filter(Boolean);
    res.json(campaigns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ BOOKING ROUTES ============

app.post('/api/bookings/slots', verifyToken, (req, res) => {
  try {
    const { title, description, duration, price, availability } = req.body;
    const creator = creators.get(req.user.id);
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    
    const bookingId = `booking_${bookingIdCounter++}`;
    const slot = {
      id: bookingId,
      creatorId: req.user.id,
      title,
      description: description || '',
      duration: parseInt(duration) || 60,
      price: parseFloat(price) || 0,
      availability: availability || ['9am-5pm'],
      bookings: [],
      createdAt: new Date()
    };
    
    bookings.set(bookingId, slot);
    creator.bookings.push(bookingId);
    creators.set(req.user.id, creator);
    
    res.status(201).json(slot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bookings/slots', verifyToken, (req, res) => {
  try {
    const creator = creators.get(req.user.id);
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    
    const slots = creator.bookings
      .map(id => bookings.get(id))
      .filter(Boolean);
    res.json(slots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ PAYMENT ROUTES (STRIPE) ============

app.post('/api/payments/stripe/create-intent', async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY.startsWith('sk_test_dummy')) {
      return res.status(400).json({ error: 'Stripe not configured' });
    }

    const { amount, creatorId, productId, currency } = req.body;
    
    const paymentIntent = await stripeClient.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: currency || 'usd',
      metadata: { creatorId, productId }
    });
    
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Stripe intent error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payments/stripe/confirm', async (req, res) => {
  try {
    const { paymentIntentId, creatorId, productId, customerEmail } = req.body;
    
    const paymentIntent = await stripeClient.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status === 'succeeded') {
      const product = products.get(productId);
      const creator = creators.get(creatorId);
      
      if (product) {
        product.sales += 1;
        product.revenue += product.price;
        products.set(productId, product);
      }
      
      if (creator) {
        creator.analytics.totalRevenue += product?.price || 0;
        creator.analytics.totalCustomers += 1;
        creator.analytics.totalSales += 1;
        creators.set(creatorId, creator);
      }
      
      const paymentRecord = {
        id: `pay_${paymentIdCounter++}`,
        creatorId,
        productId,
        customerEmail,
        amount: product?.price || 0,
        status: 'completed',
        method: 'stripe',
        createdAt: new Date()
      };
      payments.set(paymentRecord.id, paymentRecord);
      
      res.json({ 
        success: true, 
        message: 'Payment successful',
        downloadUrl: product?.fileUrl
      });
    } else {
      res.status(400).json({ error: 'Payment not completed' });
    }
  } catch (err) {
    console.error('Stripe confirm error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ PAYMENT ROUTES (PAYPAL) ============

app.post('/api/payments/paypal/create-order', async (req, res) => {
  try {
    if (!paypalClient) {
      return res.status(400).json({ error: 'PayPal not configured' });
    }

    const { amount, productId, creatorId, currency } = req.body;
    
    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: "CAPTURE",
      purchase_units: [{
        amount: {
          currency_code: currency || 'USD',
          value: amount.toString()
        },
        custom_id: JSON.stringify({ productId, creatorId })
      }]
    });
    
    const order = await paypalClient.execute(request);
    res.json({ id: order.result.id });
  } catch (err) {
    console.error('PayPal create error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payments/paypal/capture-order', async (req, res) => {
  try {
    if (!paypalClient) {
      return res.status(400).json({ error: 'PayPal not configured' });
    }

    const { orderId, creatorId, productId, customerEmail } = req.body;
    
    const request = new paypal.orders.OrdersCaptureRequest(orderId);
    request.requestBody({});
    
    const capture = await paypalClient.execute(request);
    
    if (capture.result.status === 'COMPLETED') {
      const product = products.get(productId);
      const creator = creators.get(creatorId);
      const amount = parseFloat(capture.result.purchase_units[0].amount.value);
      
      if (product) {
        product.sales += 1;
        product.revenue += amount;
        products.set(productId, product);
      }
      
      if (creator) {
        creator.analytics.totalRevenue += amount;
        creator.analytics.totalCustomers += 1;
        creator.analytics.totalSales += 1;
        creators.set(creatorId, creator);
      }
      
      const paymentRecord = {
        id: `pay_${paymentIdCounter++}`,
        creatorId,
        productId,
        customerEmail,
        amount,
        status: 'completed',
        method: 'paypal',
        createdAt: new Date()
      };
      payments.set(paymentRecord.id, paymentRecord);
      
      res.json({ 
        success: true, 
        message: 'Payment successful',
        downloadUrl: product?.fileUrl
      });
    } else {
      res.status(400).json({ error: 'Payment capture failed' });
    }
  } catch (err) {
    console.error('PayPal capture error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ ANALYTICS ROUTES ============

app.get('/api/analytics/dashboard', verifyToken, (req, res) => {
  try {
    const creator = creators.get(req.user.id);
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    
    const creatorProducts = creator.products
      .map(id => products.get(id))
      .filter(Boolean);
    
    const totalSales = creatorProducts.reduce((sum, p) => sum + p.sales, 0);
    const totalRevenue = creatorProducts.reduce((sum, p) => sum + p.revenue, 0);
    
    res.json({
      totalRevenue: totalRevenue.toFixed(2),
      totalSales,
      totalProducts: creator.products.length,
      totalMemberships: creator.subscriptions.length,
      totalCustomers: creator.analytics.totalCustomers,
      products: creatorProducts,
      memberships: creator.subscriptions.map(id => subscriptions.get(id)).filter(Boolean),
      recentActivity: Array.from(payments.values())
        .filter(p => p.creatorId === req.user.id)
        .slice(-5)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ CONTENT UPLOAD ============

app.post('/api/content/upload', verifyToken, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ 
      success: true, 
      fileUrl,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ PAYOUT SETTINGS ============

app.put('/api/creator/payout-settings', verifyToken, (req, res) => {
  try {
    const { stripeConnectId, paypalEmail } = req.body;
    const creator = creators.get(req.user.id);
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    
    if (stripeConnectId) creator.payoutSettings.stripeConnectId = stripeConnectId;
    if (paypalEmail) creator.payoutSettings.paypalEmail = paypalEmail;
    
    creators.set(req.user.id, creator);
    res.json({ ...creator, password: undefined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ ERROR HANDLING ============

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Creator Platform API running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? '✅ Configured' : '❌ Not configured'}`);
  console.log(`💰 PayPal: ${process.env.PAYPAL_CLIENT_ID ? '✅ Configured' : '❌ Not configured'}`);
  console.log(`🔐 JWT Secret: ${process.env.JWT_SECRET ? '✅ Set' : '⚠️  Using default'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
