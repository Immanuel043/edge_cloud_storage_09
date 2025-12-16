import { API_URL } from '../config/constants';

/**
 * Recommendation Service
 *
 * Handles all content recommendation related API calls including:
 * - Personalized recommendations
 * - Similar files
 * - Trending content
 * - User interactions and feedback
 */

class RecommendationService {
  // ==================== Recommendations ====================

  /**
   * Get personalized recommendations
   * @param {Object} options - Query options
   * @param {string} options.fileId - Context file ID (optional)
   * @param {string} options.algorithm - 'hybrid', 'content', 'collaborative', 'trending'
   * @param {number} options.limit - Maximum recommendations
   * @param {number} options.minScore - Minimum score threshold (0-1)
   * @param {boolean} options.forceRefresh - Force new generation
   * @returns {Promise<Array>} List of recommendations
   */
  async getRecommendations({
    fileId = null,
    algorithm = 'hybrid',
    limit = 10,
    minScore = 0.3,
    forceRefresh = false
  } = {}) {
    const params = new URLSearchParams();
    if (fileId) params.append('file_id', fileId);
    params.append('algorithm', algorithm);
    params.append('limit', limit.toString());
    params.append('min_score', minScore.toString());
    if (forceRefresh) params.append('force_refresh', 'true');

    const response = await fetch(`${API_URL}/api/v1/recommendations/?${params}`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch recommendations: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get similar files to a specific file
   * @param {string} fileId - File ID
   * @param {number} limit - Maximum similar files
   * @param {number} minScore - Minimum similarity score
   * @returns {Promise<Array>} List of similar files
   */
  async getSimilarFiles(fileId, limit = 10, minScore = 0.3) {
    const params = new URLSearchParams();
    params.append('limit', limit.toString());
    params.append('min_score', minScore.toString());

    const response = await fetch(`${API_URL}/api/v1/recommendations/similar/${fileId}?${params}`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch similar files: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get trending files
   * @param {number} limit - Maximum trending files
   * @param {number} days - Time window in days
   * @returns {Promise<Array>} List of trending files
   */
  async getTrending(limit = 10, days = 7) {
    const params = new URLSearchParams();
    params.append('limit', limit.toString());
    params.append('days', days.toString());

    const response = await fetch(`${API_URL}/api/v1/recommendations/trending?${params}`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch trending: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get recommendation summary
   * @returns {Promise<Object>} Summary data
   */
  async getSummary() {
    const response = await fetch(`${API_URL}/api/v1/recommendations/summary`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch summary: ${response.status}`);
    }

    return await response.json();
  }

  // ==================== User Interactions ====================

  /**
   * Record user interaction
   * @param {Object} interaction - Interaction data
   * @param {string} interaction.fileId - File ID
   * @param {string} interaction.interactionType - 'view', 'download', 'share', 'edit', 'delete'
   * @param {number} interaction.duration - Duration in seconds (optional)
   * @returns {Promise<Object>} Result
   */
  async recordInteraction({ fileId, interactionType, duration = null }) {
    const response = await fetch(`${API_URL}/api/v1/recommendations/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        file_id: fileId,
        interaction_type: interactionType,
        duration
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to record interaction: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Submit feedback for a recommendation
   * @param {string} recommendationId - Recommendation ID
   * @param {boolean} isHelpful - Was the recommendation helpful
   * @param {string} feedbackType - 'accept', 'dismiss', 'report'
   * @returns {Promise<Object>} Result
   */
  async submitFeedback(recommendationId, isHelpful, feedbackType = 'accept') {
    const response = await fetch(`${API_URL}/api/v1/recommendations/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        recommendation_id: recommendationId,
        is_helpful: isHelpful,
        feedback_type: feedbackType
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to submit feedback: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Dismiss a recommendation
   * @param {string} recommendationId - Recommendation ID
   * @returns {Promise<Object>} Result
   */
  async dismissRecommendation(recommendationId) {
    const response = await fetch(`${API_URL}/api/v1/recommendations/dismiss/${recommendationId}`, {
      method: 'POST',
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to dismiss recommendation: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Batch generate recommendations
   * @param {boolean} forceRefresh - Force regeneration
   * @returns {Promise<Object>} Batch result
   */
  async batchGenerate(forceRefresh = false) {
    const response = await fetch(`${API_URL}/api/v1/recommendations/batch-generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ force_refresh: forceRefresh })
    });

    if (!response.ok) {
      throw new Error(`Failed to batch generate: ${response.status}`);
    }

    return await response.json();
  }
}

export const recommendationService = new RecommendationService();
export default recommendationService;
