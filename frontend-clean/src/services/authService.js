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

    // SECURITY FIX: Include credentials to receive HTTP-only cookie
    const response = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      body: formData,
      credentials: 'include'  // Important for cookie-based auth
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

    // SECURITY FIX: Include credentials to receive HTTP-only cookie
    const response = await fetch(`${API_URL}/auth/register`, {
      method: 'POST',
      body: formData,
      credentials: 'include'  // Important for cookie-based auth
    });

    if (!response.ok) {
      throw new Error('Registration failed');
    }

    return await response.json();
  }

  async getProfile(token) {
    await rateLimiter.checkLimit();

    // SECURITY FIX: Use cookies instead of Authorization header
    const response = await fetch(`${API_URL}/users/profile`, {
      credentials: 'include'  // Send HTTP-only cookie
    });

    if (!response.ok) {
      throw new Error('Failed to load profile');
    }

    return await response.json();
  }

  async logout() {
    await rateLimiter.checkLimit();

    // SECURITY FIX: Call logout endpoint to clear HTTP-only cookie
    const response = await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include'
    });

    if (!response.ok) {
      console.error('Logout request failed');
    }

    return response.ok;
  }

  async updateTheme(token, theme) {
    await rateLimiter.checkLimit();

    // SECURITY FIX: Use cookies instead of Authorization header
    const response = await fetch(`${API_URL}/users/theme`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',  // Send HTTP-only cookie
      body: JSON.stringify({ theme })
    });

    if (!response.ok) {
      throw new Error('Failed to update theme');
    }

    return await response.json();
  }

  async getSessionToken() {
    await rateLimiter.checkLimit();

    const response = await fetch(`${API_URL}/auth/session-token`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error('Failed to refresh session token');
    }

    return await response.json();
  }
}

export const authService = new AuthService();
