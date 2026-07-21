// netlify/functions/stripe-webhook.js
// Handles Stripe events to sync subscription status to Supabase
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { assignForPlan } = require('./assign-features.js');

const PLAN_LIMITS = {
  'price_starter': { plan: 'starter', limit: 500 },
  'price_growth':  { plan: 'growth',  limit: 2000 },
  'price_pro':     { plan: 'pro',     limit: 10000 },
  'price_enterprise': { plan: 'enterprise', limit: -1 }
};

// Helper: after a plan change, log/assign the feature set for that customer.
// Resolves the user's id + previous plan from the row we just updated, so the
// feature-assignment audit log is accurate. Never throws into the webhook flow.
async function assignAfterUpdate(supabase, matchColumn, matchValue, newPlan) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, plan')
      .eq(matchColumn, matchValue)
      .limit(1)
      .single();
    if (error || !data || !data.id) return;
    await assignForPlan(data.id, newPlan, 'stripe_webhook', data.plan || null);
  } catch (e) {
    // Assignment logging is best-effort; a failure here must not break the webhook.
    console.error('assignAfterUpdate failed:', e && e.message);
  }
}

exports.handler = async function(event) {
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  switch (stripeEvent.type) {
    case 'checkout.session.completed': {
      const session = stripeEvent.data.object;
      const customerId = session.customer;
      const customerEmail = session.customer_details?.email;
      const subscriptionId = session.subscription;
      // Get price ID from subscription
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const priceId = subscription.items.data[0]?.price.id;
      const planInfo = PLAN_LIMITS[priceId] || { plan: 'starter', limit: 500 };
      // Update user profile
      await supabase
        .from('profiles')
        .update({
          plan: planInfo.plan,
          leads_limit: planInfo.limit,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          updated_at: new Date().toISOString()
        })
        .eq('email', customerEmail);
      // Auto-assign features for the new plan
      await assignAfterUpdate(supabase, 'email', customerEmail, planInfo.plan);
      break;
    }
    case 'customer.subscription.deleted': {
      const subscription = stripeEvent.data.object;
      const customerId = subscription.customer;
      // Downgrade to free
      await supabase
        .from('profiles')
        .update({
          plan: 'free',
          leads_limit: 50,
          stripe_subscription_id: null,
          updated_at: new Date().toISOString()
        })
        .eq('stripe_customer_id', customerId);
      // Auto-assign features for the free plan
      await assignAfterUpdate(supabase, 'stripe_customer_id', customerId, 'free');
      break;
    }
    case 'customer.subscription.updated': {
      const subscription = stripeEvent.data.object;
      const customerId = subscription.customer;
      const priceId = subscription.items.data[0]?.price.id;
      const planInfo = PLAN_LIMITS[priceId] || { plan: 'starter', limit: 500 };
      await supabase
        .from('profiles')
        .update({
          plan: planInfo.plan,
          leads_limit: planInfo.limit,
          updated_at: new Date().toISOString()
        })
        .eq('stripe_customer_id', customerId);
      // Auto-assign features for the updated plan
      await assignAfterUpdate(supabase, 'stripe_customer_id', customerId, planInfo.plan);
      break;
    }
  }
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
