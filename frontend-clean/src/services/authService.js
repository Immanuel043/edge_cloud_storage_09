import { API_URL } from '../config/constants';
import { sanitizeInput } from '../utils/security';
import { rateLimiter } from '../utils/rateLimiter';

class AuthService {
  async login(email, password) {
    await rateLimiter.checkLimit();
    
    const formData = new FormData();
    formData.append('email', sanitizeInput(email));
    formData.append('password', password);
    formData.append('timestamp', Date.now());
    
    const response = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      throw new Error('Invalid credentials');
    }
    
    return await response.json();
  }

  async register(email, password, username, userType) {
    await rateLimiter.checkLimit();
    
    const formData = new FormData();
    formData.append('email', sanitizeInput(email));
    formData.append('password', password);
    formData.append('username', sanitizeInput(username));
    formData.append('user_type', userType);
    formData.append('timestamp', Date.now());
    
    const response = await fetch(`${API_URL}/auth/register`, {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      throw new Error('Registration failed');
    }
    
    return await response.json();
  }

  async getProfile(token) {
    await rateLimiter.checkLimit();
    
    const response = await fetch(`${API_URL}/users/profile`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!response.ok) {
      throw new Error('Failed to load profile');
    }
    
    return await response.json();
  }

  async updateTheme(token, theme) {
    await rateLimiter.checkLimit();
    
    const response = await fetch(`${API_URL}/users/theme`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ theme })
    });
    
    if (!response.ok) {
      throw new Error('Failed to update theme');
    }
    
    return await response.json();
  }
}

export const authService = new AuthService();