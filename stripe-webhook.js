// netlify/functions/stripe-webhook.js
// Handles Stripe events to sync subscription status to Supabase

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const PLAN_LIMITS = {
  'price_starter': { plan: 'starter', limit: 500 },
  'price_growth':  { plan: 'growth',  limit: 2000 },
  'price_pro':     { plan: 'pro',     limit: 10000 },
  'price_enterprise': { plan: 'enterprise', limit: -1 }
};

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

      break;
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
