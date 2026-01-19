/**
 * Recommendation Service
 *
 * Handles all content recommendation related API calls including:
 * - Personalized recommendations
 * - Similar files
 * - Trending content
 * - User interactions and feedback
 */

import { API_URL } from '../config/constants';

// ==================== Type Definitions ====================

type RecommendationAlgorithm = 'hybrid' | 'content' | 'collaborative' | 'trending';

type InteractionType = 'view' | 'download' | 'share' | 'edit' | 'delete';

type FeedbackType = 'accept' | 'dismiss' | 'report';

interface RecommendationOptions {
  fileId?: string | null | undefined;
  algorithm?: RecommendationAlgorithm | undefined;
  limit?: number | undefined;
  minScore?: number | undefined;
  forceRefresh?: boolean | undefined;
}

interface Recommendation {
  id: string;
  file_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  score: number;
  algorithm: RecommendationAlgorithm;
  reason?: string;
  created_at: string;
}

interface SimilarFile {
  file_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  similarity_score: number;
  reason?: string;
}

interface TrendingFile {
  file_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  view_count: number;
  download_count: number;
  share_count: number;
  trending_score: number;
}

interface RecommendationSummary {
  total_recommendations: number;
  accepted_count: number;
  dismissed_count: number;
  pending_count: number;
  last_generated: string;
  average_score: number;
  algorithms_used: Record<RecommendationAlgorithm, number>;
}

interface RecordInteractionRequest {
  file_id: string;
  interaction_type: InteractionType;
  duration: number | null;
}

interface RecordInteractionResponse {
  success: boolean;
  interaction_id: string;
}

interface SubmitFeedbackRequest {
  recommendation_id: string;
  is_helpful: boolean;
  feedback_type: FeedbackType;
}

interface SubmitFeedbackResponse {
  success: boolean;
  updated: boolean;
}

interface BatchGenerateRequest {
  force_refresh: boolean;
}

interface BatchGenerateResponse {
  success: boolean;
  job_id: string;
  recommendations_count: number;
  estimated_completion_seconds?: number;
}

// ==================== Recommendation Service Class ====================

class RecommendationService {
  // ==================== Recommendations ====================

  /**
   * Get personalized recommendations
   * @param options - Query options
   * @returns List of recommendations
   */
  async getRecommendations(options: RecommendationOptions = {}): Promise<Recommendation[]> {
    const { fileId = null, algorithm = 'hybrid', limit = 10, minScore = 0.3, forceRefresh = false } = options;

    const params = new URLSearchParams();
    if (fileId) params.append('file_id', fileId);
    params.append('algorithm', algorithm);
    params.append('limit', limit.toString());
    params.append('min_score', minScore.toString());
    if (forceRefresh) params.append('force_refresh', 'true');

    const response = await fetch(`${API_URL}/api/v1/recommendations/?${params}`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch recommendations: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get similar files to a specific file
   * @param fileId - File ID
   * @param limit - Maximum similar files
   * @param minScore - Minimum similarity score
   * @returns List of similar files
   */
  async getSimilarFiles(
    fileId: string,
    limit: number = 10,
    minScore: number = 0.3
  ): Promise<SimilarFile[]> {
    const params = new URLSearchParams();
    params.append('limit', limit.toString());
    params.append('min_score', minScore.toString());

    const response = await fetch(
      `${API_URL}/api/v1/recommendations/similar/${fileId}?${params}`,
      {
        credentials: 'include',
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch similar files: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get trending files
   * @param limit - Maximum trending files
   * @param days - Time window in days
   * @returns List of trending files
   */
  async getTrending(limit: number = 10, days: number = 7): Promise<TrendingFile[]> {
    const params = new URLSearchParams();
    params.append('limit', limit.toString());
    params.append('days', days.toString());

    const response = await fetch(`${API_URL}/api/v1/recommendations/trending?${params}`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch trending: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get recommendation summary
   * @returns Summary data
   */
  async getSummary(): Promise<RecommendationSummary> {
    const response = await fetch(`${API_URL}/api/v1/recommendations/summary`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch summary: ${response.status}`);
    }

    return await response.json();
  }

  // ==================== User Interactions ====================

  /**
   * Record user interaction
   * @param interaction - Interaction data
   * @returns Result
   */
  async recordInteraction(interaction: {
    fileId: string;
    interactionType: InteractionType;
    duration?: number | null | undefined;
  }): Promise<RecordInteractionResponse> {
    const { fileId, interactionType, duration = null } = interaction;

    const requestBody: RecordInteractionRequest = {
      file_id: fileId,
      interaction_type: interactionType,
      duration,
    };

    const response = await fetch(`${API_URL}/api/v1/recommendations/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`Failed to record interaction: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Submit feedback for a recommendation
   * @param recommendationId - Recommendation ID
   * @param isHelpful - Was the recommendation helpful
   * @param feedbackType - 'accept', 'dismiss', 'report'
   * @returns Result
   */
  async submitFeedback(
    recommendationId: string,
    isHelpful: boolean,
    feedbackType: FeedbackType = 'accept'
  ): Promise<SubmitFeedbackResponse> {
    const requestBody: SubmitFeedbackRequest = {
      recommendation_id: recommendationId,
      is_helpful: isHelpful,
      feedback_type: feedbackType,
    };

    const response = await fetch(`${API_URL}/api/v1/recommendations/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`Failed to submit feedback: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Dismiss a recommendation
   * @param recommendationId - Recommendation ID
   * @returns Result
   */
  async dismissRecommendation(recommendationId: string): Promise<{ success: boolean }> {
    const response = await fetch(
      `${API_URL}/api/v1/recommendations/dismiss/${recommendationId}`,
      {
        method: 'POST',
        credentials: 'include',
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to dismiss recommendation: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Batch generate recommendations
   * @param forceRefresh - Force regeneration
   * @returns Batch result
   */
  async batchGenerate(forceRefresh: boolean = false): Promise<BatchGenerateResponse> {
    const requestBody: BatchGenerateRequest = { force_refresh: forceRefresh };

    const response = await fetch(`${API_URL}/api/v1/recommendations/batch-generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`Failed to batch generate: ${response.status}`);
    }

    return await response.json();
  }
}

export const recommendationService = new RecommendationService();
export default recommendationService;
