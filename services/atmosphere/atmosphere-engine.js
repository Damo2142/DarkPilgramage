/**
 * Atmosphere Engine Service
 * Controls smart home lighting (Hubitat), audio cues, and player screen effects
 * based on atmosphere profile changes from the AI or DM.
 */

const fs = require('fs');
const path = require('path');

class AtmosphereEngine {
  constructor() {
    this.name = 'atmosphere';
    this.orchestrator = null;
    this.profiles = {};
    this.currentProfile = null;
    this._transitioning = false;
    this._flickerInterval = null;
    this._flickerState = true;
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;

    this.hubitat = {
      host: this.config.hubitat?.host || '192.168.0.131',
      appId: this.config.hubitat?.makerApiAppId || '1102',
      token: process.env[this.config.hubitat?.tokenEnv || 'HUBITAT_TOKEN'] || process.env.HUBITAT_TOKEN
    };

    this.lights = {
      color: this.config.lightDevices?.color || [912, 913],
      ambient: this.config.lightDevices?.ambient || [880, 881, 649, 582]
    };

    this._loadProfiles();
  }

  async start() {
    this.bus.subscribe('atmo:change', async (env) => {
      const { profile, reason, auto } = env.data;
      console.log(`[Atmosphere] Profile change: ${profile} (${reason || 'manual'}${auto ? ', auto' : ''})`);
      await this.setProfile(profile);
    }, 'atmosphere');

    this.bus.subscribe('atmo:light', async (env) => {
      await this._handleLightCommand(env.data);
    }, 'atmosphere');

    this.bus.subscribe('panic', async () => {
      console.log('[Atmosphere] PANIC — restoring all lights');
      await this._panic();
    }, 'atmosphere');

    this.bus.subscribe('session:started', async () => {
      const initialProfile = this.state.get('atmosphere.currentProfile') || 'tavern_warm';
      console.log('[Atmosphere] Session started — taking light control');
      await this._claimLights();
      await this._sleep(1000);
      console.log(`[Atmosphere] Setting initial profile: ${initialProfile}`);
      await this.setProfile(initialProfile);
    }, 'atmosphere');

    this.bus.subscribe('session:ended', async () => {
      console.log('[Atmosphere] Session ended — turning lights off');
      await this._lightsOff();
    }, 'atmosphere');

    if (!this.hubitat.token) {
      console.warn('[Atmosphere] No HUBITAT_TOKEN found — light control disabled');
    } else {
      console.log(`[Atmosphere] Hubitat: ${this.hubitat.host}, ${this.lights.color.length} color + ${this.lights.ambient.length} ambient lights`);
    }
  }

  _loadProfiles() {
    const profileDir = path.join(__dirname, '..', '..', 'config', 'atmosphere-profiles');
    try {
      const files = fs.readdirSync(profileDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const name = file.replace('.json', '');
        this.profiles[name] = JSON.parse(fs.readFileSync(path.join(profileDir, file), 'utf-8'));
      }
      console.log(`[Atmosphere] Loaded ${Object.keys(this.profiles).length} profiles`);
    } catch (e) {
      console.warn('[Atmosphere] No atmosphere profiles found');
    }
  }

  async _claimLights() {
    if (!this.hubitat.token) return;

    const allDevices = [...this.lights.color, ...this.lights.ambient];
    console.log(`[Atmosphere] Claiming ${allDevices.length} lights...`);

    await Promise.allSettled(allDevices.map(id => this._hubitatCommand(id, 'off')));
    await this._sleep(500);
    await Promise.allSettled(allDevices.map(id => this._hubitatCommand(id, 'on')));
    await this._sleep(500);

    console.log('[Atmosphere] Lights claimed');
  }

  async setProfile(profileName) {
    const normalized = profileName.replace(/-/g, '_');
    const hyphenated = profileName.replace(/_/g, '-');
    const profile = this.profiles[normalized] || this.profiles[hyphenated] || this.profiles[profileName];

    if (!profile) {
      console.error(`[Atmosphere] Unknown profile: ${profileName}`);
      return;
    }

    if (this._transitioning) {
      console.log('[Atmosphere] Already transitioning — queuing');
    }

    this._transitioning = true;
    this.currentProfile = profile;
    this.state.set('atmosphere.currentProfile', profile.name || profileName);

    try {
      await Promise.allSettled([
        this._applyLighting(profile.lights),
        this._applyAmbientLights(profile),
        this._applyPlayerEffects(profile.playerEffects),
        this._applyFlicker(profile.lights?.flicker)
      ]);

      this.bus.dispatch('atmo:profile_active', {
        profile: profile.name || profileName,
        horrorLevel: profile.horrorLevel || 0,
        audio: profile.audio || null
      });

      console.log(`[Atmosphere] Profile active: ${profile.name || profileName} (horror: ${profile.horrorLevel || 0})`);

    } catch (err) {
      console.error(`[Atmosphere] Error applying profile: ${err.message}`);
    }

    this._transitioning = false;
  }

  /**
   * Apply color lighting to RGB bulbs
   * Profile format uses Hubitat-native values directly:
   *   hue: 0-100, sat: 0-100, level: 0-100
   */
  async _applyLighting(lightConfig) {
    if (!lightConfig || !this.hubitat.token) return;

    const { hue, sat, level } = lightConfig.color || {};
    if (hue === undefined) return;

    for (const deviceId of this.lights.color) {
      await this._hubitatCommand(deviceId, 'setHue', hue);
      await this._sleep(100);
      await this._hubitatCommand(deviceId, 'setSaturation', sat);
      await this._sleep(100);
      await this._hubitatCommand(deviceId, 'setLevel', level);
      await this._sleep(100);
    }
  }

async _applyAmbientLights(profile) {
    if (!this.hubitat.token) return;

    // Ambient lights stay off during sessions — RGB only
    const commands = this.lights.ambient.map(deviceId =>
      this._hubitatCommand(deviceId, 'off')
    );

    await Promise.allSettled(commands);
  }
  async _applyPlayerEffects(effects) {
    if (!effects) return;

    if (effects.screenTint) {
      this.bus.dispatch('player:horror_effect', {
        playerId: 'all',
        type: 'screen_tint',
        payload: effects.screenTint,
        durationMs: 0
      });
    }

    if (effects.screenFlash) {
      this.bus.dispatch('player:horror_effect', {
        playerId: 'all',
        type: 'screen_flash',
        payload: effects.screenFlash,
        durationMs: effects.screenFlash.flashMs || 200
      });
    }

    if (effects.glitch && Math.random() < (effects.glitch.chance || 0.1)) {
      this.bus.dispatch('player:horror_effect', {
        playerId: 'all',
        type: 'glitch',
        payload: {},
        durationMs: effects.glitch.durationMs || 500
      });
    }
  }

  async _applyFlicker(flickerConfig) {
    if (this._flickerInterval) {
      clearInterval(this._flickerInterval);
      this._flickerInterval = null;
    }

    if (!flickerConfig?.enabled || !this.hubitat.token) return;

    const intensity = flickerConfig.intensity || 0.2;
    const speed = flickerConfig.speed || 'slow';

    const speedMap = {
      slow: 3000,
      slow_pulse: 4000,
      medium: 1500,
      fast: 500
    };

    const intervalMs = speedMap[speed] || 2000;

    this._flickerInterval = setInterval(async () => {
      if (!this.currentProfile) return;

      const baseLevel = this.currentProfile.lights?.color?.level || 50;
      const variation = Math.round(baseLevel * intensity);
      const flickerLevel = this._flickerState
        ? Math.max(1, baseLevel - variation)
        : baseLevel;

      this._flickerState = !this._flickerState;

      const commands = this.lights.color.map(deviceId =>
        this._hubitatCommand(deviceId, 'setLevel', flickerLevel)
      );

      await Promise.allSettled(commands);
    }, intervalMs);
  }

  async _handleLightCommand(data) {
    if (!this.hubitat.token) return;

    const { command, devices, value } = data;

    let targetDevices = [];
    if (devices === 'color') targetDevices = this.lights.color;
    else if (devices === 'ambient') targetDevices = this.lights.ambient;
    else if (devices === 'all') targetDevices = [...this.lights.color, ...this.lights.ambient];
    else if (Array.isArray(devices)) targetDevices = devices;

    const commands = targetDevices.map(id =>
      this._hubitatCommand(id, command, value)
    );

    await Promise.allSettled(commands);
  }

  async _lightsOff() {
    if (this._flickerInterval) {
      clearInterval(this._flickerInterval);
      this._flickerInterval = null;
    }
    if (!this.hubitat.token) return;
    const allDevices = [...this.lights.color, ...this.lights.ambient];
    console.log('[Atmosphere] Turning off ' + allDevices.length + ' lights');
    await Promise.allSettled(allDevices.map(id => this._hubitatCommand(id, 'off')));
    this.state.set('atmosphere.currentProfile', 'off');
    console.log('[Atmosphere] All lights off');
  }

  async _panic() {
    if (this._flickerInterval) {
      clearInterval(this._flickerInterval);
      this._flickerInterval = null;
    }

    if (!this.hubitat.token) return;

    for (const id of this.lights.color) {
      await this._hubitatCommand(id, 'setColorTemperature', 2700);
      await this._sleep(100);
      await this._hubitatCommand(id, 'setLevel', 100);
      await this._sleep(100);
    }

    const ambientCommands = this.lights.ambient.map(id =>
      this._hubitatCommand(id, 'setLevel', 100)
    );
    await Promise.allSettled(ambientCommands);

    this.bus.dispatch('player:horror_effect', {
      playerId: 'all',
      type: 'screen_tint',
      payload: { color: 'transparent' },
      durationMs: 0
    });

    this.state.set('atmosphere.currentProfile', 'panic');
  }

  async _hubitatCommand(deviceId, command, value) {
    const url = value !== undefined
      ? `http://${this.hubitat.host}/apps/api/${this.hubitat.appId}/devices/${deviceId}/${command}/${value}?access_token=${this.hubitat.token}`
      : `http://${this.hubitat.host}/apps/api/${this.hubitat.appId}/devices/${deviceId}/${command}?access_token=${this.hubitat.token}`;

    try {
      const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
      if (!response.ok) {
        console.error(`[Atmosphere] Hubitat error for device ${deviceId}: ${response.status}`);
      }
    } catch (err) {
      console.error(`[Atmosphere] Hubitat request failed for device ${deviceId}: ${err.message}`);
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async stop() {
    if (this._flickerInterval) {
      clearInterval(this._flickerInterval);
      this._flickerInterval = null;
    }
  }

  getStatus() {
    return {
      status: 'running',
      currentProfile: this.state?.get('atmosphere.currentProfile') || null,
      profileCount: Object.keys(this.profiles).length,
      hubitatConnected: !!this.hubitat.token,
      colorLights: this.lights.color,
      ambientLights: this.lights.ambient,
      flickerActive: !!this._flickerInterval
    };
  }
}

module.exports = AtmosphereEngine;
