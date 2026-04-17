/**
 * services/items/bagman-service.js — Task 10 (session0-polish follow-up)
 *
 * The bag-of-holding-cellar item has a bagman:true hidden flag. This
 * service tracks how many times it's been reached into and escalates
 * the outcome per tier.
 *
 * State:
 *   state.items.bag-of-holding-cellar.bagmanState = {
 *     reachCount: 0,
 *     lastReachTime: null,
 *     carrier: null,
 *     awareOfParty: false
 *   }
 *
 * REST:
 *   POST /api/items/bag-of-holding/reach
 *     body: { playerId, requestedItem }
 *     response: { tier, reachCount, outcome, privateWhisper, dmEarbud,
 *                 saveRequired?: 'STR DC 12' }
 *
 * Events dispatched:
 *   player:private_whisper { playerId, text }    — Chromebook narrative
 *   dm:whisper             { text, priority, category } — DM earbud
 *   bagman:reach           { playerId, tier, requestedItem } — structured
 *   bagman:awareness_acquired { playerId }       — one-shot when tier 5 fires
 */

class BagmanService {
  constructor() {
    this.name = 'bagman';
    this.orchestrator = null;
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;
  }

  async start() {
    this._setupRoutes();
    console.log('[BagmanService] Ready — 8-tier reach escalation wired');
  }

  async stop() { /* no timers */ }

  getStatus() {
    const s = this.state.get('items.bag-of-holding-cellar.bagmanState') || {};
    return {
      status: 'ok',
      reachCount: s.reachCount || 0,
      awareOfParty: s.awareOfParty === true,
      carrier: s.carrier || null
    };
  }

  _getState() {
    return this.state.get('items.bag-of-holding-cellar.bagmanState') || {
      reachCount: 0, lastReachTime: null, carrier: null, awareOfParty: false
    };
  }

  _setState(next) {
    this.state.set('items.bag-of-holding-cellar.bagmanState', next);
  }

  /**
   * Process a reach-into-bag action. Increments reachCount, returns the
   * tier outcome. Dispatches DM + player whispers.
   *
   * @param {object} opts { playerId, requestedItem }
   * @returns {object} { tier, reachCount, itemDelivered, outcome,
   *                     privateWhisper, dmEarbud, saveRequired }
   */
  reach(opts) {
    const { playerId, requestedItem } = opts || {};
    if (!playerId) {
      return { error: 'playerId required' };
    }

    const s = this._getState();
    const tier = (s.reachCount || 0) + 1;
    const next = {
      ...s,
      reachCount: tier,
      lastReachTime: new Date().toISOString(),
      carrier: playerId,   // whoever reaches becomes the carrier
      awareOfParty: s.awareOfParty || tier >= 5
    };
    this._setState(next);

    // Resolve tier
    const outcome = this._tierOutcome(tier);

    // Whisper the private narrative to the player's Chromebook
    if (outcome.privateWhisper) {
      this.bus.dispatch('player:private_whisper', {
        playerId, text: outcome.privateWhisper,
        source: 'bagman', tier
      });
    }

    // DM earbud whisper with mechanical context
    const dmText = outcome.dmEarbud
      ? `[BAGMAN tier ${tier}/8] ${outcome.dmEarbud}`
      : `[BAGMAN tier ${tier}/8] ${playerId} reached for ${requestedItem || 'an item'} — tier outcome as specified.`;
    this.bus.dispatch('dm:whisper', {
      text: dmText, priority: outcome.priority || 2,
      category: 'items', source: 'bagman-service'
    });

    // Structured event
    this.bus.dispatch('bagman:reach', {
      playerId, requestedItem, tier, outcome: outcome.summary
    });
    // One-shot awareness event
    if (tier === 5) {
      this.bus.dispatch('bagman:awareness_acquired', { playerId });
    }

    return {
      tier, reachCount: tier,
      itemDelivered: true,  // every reach delivers the requested item
      outcome: outcome.summary,
      privateWhisper: outcome.privateWhisper,
      dmEarbud: outcome.dmEarbud,
      saveRequired: outcome.saveRequired || null,
      awareOfParty: next.awareOfParty
    };
  }

  _tierOutcome(tier) {
    // Tier 1: Safe. Correct item. Slightly cold inside.
    if (tier === 1) return {
      summary: 'safe',
      privateWhisper: "The bag is surprisingly deep — colder than it should be, inside. You find what you asked for.",
      dmEarbud: 'Safe. Item delivered. Brief cold-inside flavor to the reacher.',
      priority: 3
    };
    // Tier 2: Safe. Feels briefly watched.
    if (tier === 2) return {
      summary: 'safe-watched',
      privateWhisper: "Your hand closes on the item. For a heartbeat you feel watched — like something inside the bag just noticed you. It passes.",
      dmEarbud: 'Safe. Item delivered. Reacher felt briefly watched.',
      priority: 3
    };
    // Tier 3: Item plus an unexpected extra
    if (tier === 3) return {
      summary: 'item-plus-artifact',
      privateWhisper: "You pull out the item — and something else. A dry leaf. Or a lock of grey hair. Or a child's tooth. You drop it on the table without thinking.",
      dmEarbud: 'Item plus dry leaf / lock of grey hair / child tooth (DM picks). Reacher drops it involuntarily.',
      priority: 2
    };
    // Tier 4: Item is damp
    if (tier === 4) return {
      summary: 'damp',
      privateWhisper: "The item you pull out is damp. Not wet — damp. Like it has been sitting in a cellar. You remember the cellar below this inn and decide not to look at your own hand.",
      dmEarbud: 'Item delivered, damp. Reacher narratively unsettled.',
      priority: 2
    };
    // Tier 5: Voice whispers "Thank you" — awareness acquired
    if (tier === 5) return {
      summary: 'voice-thank-you',
      privateWhisper: "As your hand leaves the bag, you hear — just barely, under the sound of your own breath — a voice. It says: 'Thank you.' It is not a voice you know. AWARENESS.",
      dmEarbud: 'AWARENESS — "Thank you." The Bagman has noticed the party. state.items.bag-of-holding-cellar.bagmanState.awareOfParty = true. This flag carries to Houska and beyond.',
      priority: 1
    };
    // Tier 6: Cold breath on the hand
    if (tier === 6) return {
      summary: 'cold-breath',
      privateWhisper: "As your hand pulls out the item, something cold brushes the back of it — not air. A breath. The item is warmer than it should be.",
      dmEarbud: 'Cold breath on the reacher\'s hand. Item warmer than expected.',
      priority: 1
    };
    // Tier 7: d20 pale finger or item-only
    if (tier === 7) {
      const d20 = Math.floor(Math.random() * 20) + 1;
      if (d20 <= 5) {
        return {
          summary: 'pale-finger-graze',
          privateWhisper: "Inside the bag, a pale finger — too long, too cold — grazes your wrist as you close your hand on the item. It's still there when you pull back. It lingers until you look. Then it's gone.",
          dmEarbud: `d20=${d20} — pale finger grazed wrist. PC may need a brief CON save or lose a point of HP to cold — DM discretion.`,
          priority: 1
        };
      }
      return {
        summary: 'item-only-d20-saved',
        privateWhisper: "The bag is quiet. You pull out the item.",
        dmEarbud: `d20=${d20} — no graze, safe pull.`,
        priority: 2
      };
    }
    // Tier 8+: STR DC 12 save to withdraw
    return {
      summary: 'str-save-dc12',
      privateWhisper: "Something inside the bag closes around your wrist — you feel fingers, unmistakably fingers, and for a fraction of a second you know it is not going to let go. STR save DC 12 to pull free.",
      dmEarbud: 'Tier 8+ — STR save DC 12 required. Fail: Bagman holds wrist. Item not delivered until wrist is freed. Succeed: item delivered, wrist released.',
      priority: 1,
      saveRequired: 'STR DC 12'
    };
  }

  _setupRoutes() {
    const dashboard = this.orchestrator.getService('dashboard');
    if (!dashboard?.app) {
      console.warn('[BagmanService] Dashboard not available for route mounting');
      return;
    }
    const app = dashboard.app;

    // POST /api/items/bag-of-holding/reach — body: { playerId, requestedItem }
    app.post('/api/items/bag-of-holding/reach', (req, res) => {
      try {
        const { playerId, requestedItem } = req.body || {};
        if (!playerId) return res.status(400).json({ error: 'playerId required' });
        const result = this.reach({ playerId, requestedItem });
        if (result.error) return res.status(400).json(result);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // GET /api/items/bag-of-holding/state — inspect current state (DM tool)
    app.get('/api/items/bag-of-holding/state', (req, res) => {
      res.json(this._getState());
    });

    // POST /api/items/bag-of-holding/reset — reset reach count (testing)
    app.post('/api/items/bag-of-holding/reset', (req, res) => {
      this._setState({
        reachCount: 0, lastReachTime: null, carrier: null, awareOfParty: false
      });
      res.json({ ok: true, reset: true });
    });
  }
}

module.exports = BagmanService;
