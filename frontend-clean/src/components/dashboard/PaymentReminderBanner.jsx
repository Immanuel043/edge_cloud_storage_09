import React, { useState, useEffect } from 'react';
import { CreditCard, X, Calendar, AlertCircle } from 'lucide-react';
import API_CONFIG from '../../config/api';

export default function PaymentReminderBanner({ darkMode }) {
  const [paymentData, setPaymentData] = useState(null);
  const [isVisible, setIsVisible] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUpcomingPayment();
  }, []);

  const fetchUpcomingPayment = async () => {
    try {
      const response = await fetch(`${API_CONFIG.STORAGE_API}/api/v1/billing/upcoming-payment`, {
        credentials: 'include'
      });

      if (response.ok) {
        const data = await response.json();

        // Check if banner was dismissed today
        if (!wasDismissedToday()) {
          setPaymentData(data);
          setIsVisible(true);
        }
      }
      // 404 is expected for free users or when no payment is due within 7 days
      // Silently handle it without logging errors
    } catch (error) {
      // Only log unexpected errors (not 404s)
      if (error.status !== 404) {
        console.error('Failed to fetch upcoming payment:', error);
      }
    } finally {
      setLoading(false);
    }
  };

  const wasDismissedToday = () => {
    const dismissal = localStorage.getItem('payment_reminder_dismissed');
    if (!dismissal) return false;

    const dismissedAt = parseInt(dismissal);
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    return (now - dismissedAt) < oneDayMs;
  };

  const handleDismiss = () => {
    localStorage.setItem('payment_reminder_dismissed', Date.now().toString());
    setIsVisible(false);
  };

  if (loading || !isVisible || !paymentData) {
    return null;
  }

  const formatDate = (isoDate) => {
    return new Date(isoDate).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const getUrgencyColor = (days) => {
    if (days <= 1) return 'red';
    if (days <= 3) return 'orange';
    return 'blue';
  };

  const urgency = getUrgencyColor(paymentData.days_until_payment);
  const colors = {
    red: {
      gradient: 'from-red-50 to-pink-50',
      border: 'border-red-200',
      icon: 'bg-red-100 text-red-600',
      text: 'text-red-900',
      subtext: 'text-red-700',
      button: 'bg-red-600 hover:bg-red-700 text-white'
    },
    orange: {
      gradient: 'from-orange-50 to-yellow-50',
      border: 'border-orange-200',
      icon: 'bg-orange-100 text-orange-600',
      text: 'text-orange-900',
      subtext: 'text-orange-700',
      button: 'bg-orange-600 hover:bg-orange-700 text-white'
    },
    blue: {
      gradient: 'from-blue-50 to-indigo-50',
      border: 'border-blue-200',
      icon: 'bg-blue-100 text-blue-600',
      text: 'text-blue-900',
      subtext: 'text-blue-700',
      button: 'bg-blue-600 hover:bg-blue-700 text-white'
    }
  };

  const color = colors[urgency];

  return (
    <div className={`bg-gradient-to-r ${color.gradient} border ${color.border} rounded-lg p-4 mb-4`}>
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className={`p-2 ${color.icon} rounded-lg flex-shrink-0`}>
          <CreditCard size={20} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <h3 className={`font-semibold ${color.text} flex items-center gap-2`}>
                {paymentData.days_until_payment <= 1 && (
                  <AlertCircle size={16} className="flex-shrink-0" />
                )}
                Payment Reminder
              </h3>
              <p className={`text-sm ${color.subtext} mt-1`}>
                Your <strong>{paymentData.plan_name}</strong> subscription ({paymentData.billing_cycle.replace('_', ' ')})
                will renew in <strong>{paymentData.days_until_payment} day{paymentData.days_until_payment !== 1 ? 's' : ''}</strong>.
              </p>

              {/* Payment Details */}
              <div className="mt-3 flex items-center gap-4 text-sm">
                <div className="flex items-center gap-2">
                  <Calendar size={14} className={color.subtext} />
                  <span className={color.text}>
                    {formatDate(paymentData.payment_due_date)}
                  </span>
                </div>
                <div className={`font-semibold ${color.text}`}>
                  ₹{paymentData.amount_due.toFixed(2)}
                </div>
              </div>
            </div>

            {/* Dismiss Button */}
            <button
              onClick={handleDismiss}
              className="text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
              aria-label="Dismiss"
            >
              <X size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
