import { useEffect, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCircle2, LifeBuoy, RotateCcw, XCircle } from 'lucide-react';
import { Button, Card, CardContent } from '@/components/ui';

/**
 * BillingResult — post-checkout landing pages rendered after Stripe
 * redirects back to /billing/success or /billing/failure. Extracted from
 * `App.tsx` so the result UI is first-class and can be styled with
 * primitives. Success page auto-redirects to dashboard after 3s; failure
 * page surfaces actionable next steps (retry, change method, contact
 * support) instead of leaving the user stuck.
 */

export function BillingSuccessPage(): ReactElement {
  const navigate = useNavigate();

  useEffect(() => {
    const timer = setTimeout(() => {
      navigate('/', { replace: true });
    }, 3000);
    return () => clearTimeout(timer);
  }, [navigate]);

  return (
    <div className="min-h-screen bg-bg px-6 py-20">
      <div className="mx-auto flex max-w-md items-center justify-center">
        <Card variant="elevated" className="w-full">
          <CardContent className="p-8 text-center">
            <div
              aria-hidden
              className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-success/15 text-success"
            >
              <CheckCircle2 className="h-8 w-8" />
            </div>
            <h1 className="mb-2 text-h2 font-semibold text-fg">Payment successful</h1>
            <p className="mb-6 text-body text-fg-muted">
              Your subscription has been activated. Redirecting to your dashboard…
            </p>
            <Button
              variant="primary"
              size="lg"
              fullWidth
              rightIcon={<ArrowRight className="h-4 w-4" />}
              onClick={() => navigate('/', { replace: true })}
            >
              Go to dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function BillingFailurePage(): ReactElement {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-bg px-6 py-20">
      <div className="mx-auto flex max-w-md items-center justify-center">
        <Card variant="elevated" className="w-full">
          <CardContent className="p-8 text-center">
            <div
              aria-hidden
              className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-danger/15 text-danger"
            >
              <XCircle className="h-8 w-8" />
            </div>
            <h1 className="mb-2 text-h2 font-semibold text-fg">Payment failed</h1>
            <p className="mb-6 text-body text-fg-muted">
              Something went wrong with your payment. No charges were made to your card.
            </p>

            <div className="space-y-2">
              <Button
                variant="primary"
                size="lg"
                fullWidth
                leftIcon={<RotateCcw className="h-4 w-4" />}
                onClick={() => navigate('/pricing')}
              >
                Try again
              </Button>
              <Button
                variant="secondary"
                size="md"
                fullWidth
                onClick={() => navigate('/', { replace: true })}
              >
                Back to dashboard
              </Button>
            </div>

            <div className="mt-6 border-t border-border pt-4">
              <Link
                to="mailto:support@edgecloudstorage.com"
                className="inline-flex items-center gap-2 text-body-sm font-medium text-primary hover:text-primary-hover"
              >
                <LifeBuoy className="h-4 w-4" />
                Contact support
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default BillingSuccessPage;
