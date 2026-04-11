/**
 * Perception Intercepts — Section 3
 *
 * When a token movement path crosses a window waypoint, calculate
 * passive perception checks for each player and fire perception flash
 * events to player Chromebooks for those who beat the DC.
 */

class PerceptionIntercepts {
  constructor(orchestrator, bus, state, config) {
    this.orchestrator = orchestrator;
    this.bus = bus;
    this.state = state;
    this.config = config;
    this.windowWaypoints = [];
  }

  init() {
    // Load window waypoints from session config
    const session = this.config?.world?.windowWaypoints || this.config?.windowWaypoints || [];
    this.windowWaypoints = session;
    if (this.windowWaypoints.length === 0) {
      console.log('[PerceptionIntercepts] No window waypoints in config');
    } else {
      console.log(`[PerceptionIntercepts] ${this.windowWaypoints.length} window waypoints loaded`);
    }

    // Listen for token movements
    this.bus.subscribe('map:token_moved', (env) => {
      this._checkWindowCrossing(env.data);
    }, 'perception-intercepts');
  }

  _checkWindowCrossing(data) {
    if (!data || !data.tokenId) return;
    const { tokenId, x, y, oldX, oldY } = data;
    const token = this.state.get('map.tokens.' + tokenId);
    if (!token) return;

    // Only fire for non-player tokens (creatures/NPCs passing windows)
    if (token.type === 'pc' || token.isPC) return;

    const map = this.state.get('map') || {};
    const gs = map.gridSize || 70;

    for (const wp of this.windowWaypoints) {
      const wpx = wp.x * gs;
      const wpy = wp.y * gs;
      const distNew = Math.hypot(x - wpx, y - wpy);
      const distOld = Math.hypot((oldX || x) - wpx, (oldY || y) - wpy);
      // Path crosses if it enters the perception range (within 2 squares of window)
      if (distNew < 2 * gs && distOld >= 2 * gs) {
        this._fireWindowIntercept(token, tokenId, wp);
      }
    }
  }

  _fireWindowIntercept(token, tokenId, waypoint) {
    // Calculate perception DC
    let dc = waypoint.perceptionBaseDC || 15;
    const stealthBonus = token.stealthBonus || 0;
    dc += stealthBonus;
    // Subtract 2 per nearby light source — use simple heuristic
    const lights = this.state.get('lights') || {};
    let nearLights = 0;
    for (const l of Object.values(lights)) {
      if (l && l.active) nearLights++;
    }
    dc -= Math.min(6, nearLights * 2);
    // Blizzard +4 (Session 0 default)
    const weather = this.state.get('world.weather') || {};
    if (weather.type === 'blizzard') dc += 4;

    // Check each player's passive perception
    const players = this.state.get('players') || {};
    const reportLines = [];
    for (const [pid, p] of Object.entries(players)) {
      if (p.absent || p.notYetArrived) continue;
      const pp = p.character?.passivePerception || p.character?.passivePerception || 10;
      if (pp >= dc) {
        const margin = pp - dc;
        const description = this._descriptionByMargin(margin, token);
        this.bus.dispatch('player:perception_flash', {
          playerId: pid,
          description,
          margin,
          waypoint: waypoint.id
        });
        reportLines.push(`${p.character?.name || pid} (PP ${pp}) — beat DC by ${margin}`);
      }
    }

    // Full DM earbud report
    const truth = `${token.name || tokenId} crossed ${waypoint.description}. DC ${dc}.`;
    const report = reportLines.length
      ? `${truth} Perceived: ${reportLines.join(', ')}`
      : `${truth} Nobody perceived.`;
    this.bus.dispatch('dm:whisper', {
      text: report,
      priority: 2,
      category: 'perception',
      source: 'max'
    });
  }

  _descriptionByMargin(margin, token) {
    const isLetavec = (token.name || '').toLowerCase().includes('letavec');
    const isKamenny = (token.name || '').toLowerCase().includes('kamen');
    if (margin >= 10) {
      if (isLetavec) return "Membrane wings, folded tight against a body the size of a horse.";
      if (isKamenny) return "Stone-grey, motionless, then not.";
      return "A specific shape — a creature you do not have a name for, walking with purpose.";
    }
    if (margin >= 5) {
      return "A shape — wrong proportions for any animal you have a name for.";
    }
    return "Something large moved past the window.";
  }
}

module.exports = PerceptionIntercepts;
