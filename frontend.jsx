import React, { useState } from 'react';

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [isLogin, setIsLogin] = useState(true);
  const [user, setUser] = useState(null);

  const API_BASE = 'https://creator-platform-api-xxxxx.onrender.com/api';

  const handleAuth = async (e) => {
    e.preventDefault();
    const endpoint = isLogin ? 'login' : 'register';
    try {
      const res = await fetch(`${API_BASE}/auth/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, ...(isLogin ? {} : { name }) })
      });
      const data = await res.json();
      if (data.token) {
        setToken(data.token);
        localStorage.setItem('token', data.token);
        setUser(data.creator);
      }
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  const handleLogout = () => {
    setToken(null);
    localStorage.removeItem('token');
    setUser(null);
  };

  if (!token) {
    return (
      <div style={{ maxWidth: '400px', margin: '50px auto', padding: '20px' }}>
        <h1>Creator Platform</h1>
        <div style={{ marginBottom: '10px' }}>
          <button onClick={() => setIsLogin(true)} style={{ marginRight: '10px' }}>Login</button>
          <button onClick={() => setIsLogin(false)}>Register</button>
        </div>
        <form onSubmit={handleAuth}>
          {!isLogin && (
            <input
              type="text"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ width: '100%', padding: '10px', marginBottom: '10px', boxSizing: 'border-box' }}
              required
            />
          )}
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: '100%', padding: '10px', marginBottom: '10px', boxSizing: 'border-box' }}
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: '100%', padding: '10px', marginBottom: '10px', boxSizing: 'border-box' }}
            required
          />
          <button type="submit" style={{ width: '100%', padding: '10px', background: '#667eea', color: 'white', border: 'none', cursor: 'pointer' }}>
            {isLogin ? 'Login' : 'Register'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
        <h1>Dashboard</h1>
        <button onClick={handleLogout} style={{ padding: '10px 20px', background: '#e74c3c', color: 'white', border: 'none', cursor: 'pointer' }}>
          Logout
        </button>
      </div>
      {user && <p>Welcome, {user.name}</p>}
      <div style={{ background: '#f0f0f0', padding: '20px', borderRadius: '5px' }}>
        <h2>Welcome to Your Creator Platform!</h2>
        <p>This is your dashboard. Build and deploy with us!</p>
      </div>
    </div>
  );
}
