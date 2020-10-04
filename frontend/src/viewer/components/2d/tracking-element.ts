import { toRad } from 'geolib';
import { CSSResult, customElement, html, internalProperty, LitElement, TemplateResult } from 'lit-element';
import { connect } from 'pwa-helpers';

import { setDisplayLiveNames } from '../../actions';
import { linearInterpolate } from '../../logic/math';
import { formatUnit } from '../../logic/units';
import { Units } from '../../reducers';
import { RootState, store } from '../../store';
import { controlStyle } from '../control-style';

const SPEECH_BUBBLE =
  'M2.5 2C1.7 2 1 2.7 1 3.5 l 0 8 c0 .8.7 1.5 1.5 1.5 H4 l 0 2.4 L 7.7 13 l 4.8 0 c.8 0 1.5 -.7 1.5 -1.5 l 0 -8 c 0 -.8 -.7 -1.5 -1.5 -1.5 z';

@customElement('tracking-element')
export class TrackingElement extends connect(store)(LitElement) {
  @internalProperty()
  private displayNames = true;

  @internalProperty()
  get map(): google.maps.Map | undefined {
    return this.map_;
  }
  set map(map: google.maps.Map | undefined) {
    this.map_ = map;
    if (map) {
      this.handleVisibility();
      this.setMapStyle(map);
      this.setupInfoWindow(map);
    }
  }
  map_: google.maps.Map | undefined;

  private units?: Units;

  private info: google.maps.InfoWindow | undefined;
  // Name of the pilot shown in the info window.
  private currentName?: string;

  private features: any[] = [];

  private fetchId: any = null;

  private readonly visibilityListener = () => this.handleVisibility();

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('visibilitychange', this.visibilityListener);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('visibilitychange', this.visibilityListener);
  }

  // Do not fetch the trackers when flyxc is not visible.
  // Saves battery on mobiles.
  private handleVisibility(): void {
    const visible = document.visibilityState == 'visible';
    if (visible) {
      if (this.fetchId == null) {
        this.fetchTrackers();
        this.fetchId = setInterval(() => this.fetchTrackers(), 2 * 60 * 1000);
      }
    } else {
      if (this.fetchId != null) {
        clearInterval(this.fetchId);
        this.fetchId = null;
      }
    }
  }

  stateChanged(state: RootState): void {
    this.units = state.map.units;
    this.displayNames = state.map.displayLiveNames;
  }

  static get styles(): CSSResult {
    return controlStyle;
  }

  private fetchTrackers(): void {
    fetch('_trackers.geojson')
      .then((r) => (r.ok ? r.json() : null))
      .then((geoJson) => {
        if (geoJson != null) {
          const features = this.features;
          this.features = this.map?.data.addGeoJson(geoJson) || [];
          features.forEach((f) => this.map?.data.remove(f));
        }
      });
  }

  private setupInfoWindow(map: google.maps.Map): void {
    const hasPointFeature = (event: any): boolean => event.feature?.getGeometry().getType() == 'Point';
    this.info = new google.maps.InfoWindow();
    this.info.close();
    this.info.addListener('closeclick', () => {
      this.currentName = undefined;
      if (this.map) {
        this.setMapStyle(this.map);
      }
    });

    map.data.addListener('click', (event: any) => {
      if (hasPointFeature(event)) {
        const f = event.feature as any;
        const latLng: google.maps.LatLng = f.getGeometry().get();
        const date = new Date(f.getProperty('ts'));
        const content: string[] = [
          `<strong>${f.getProperty('name')}</strong>`,
          `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`,
          `${formatUnit(f.getProperty('alt'), this.units?.altitude || 'm')} ${
            f.getProperty('speed') != null ? formatUnit(f.getProperty('speed'), this.units?.speed || 'km/h') : ''
          }`,
          `<a href=${`https://www.google.com/maps/dir//${latLng.lat()},${latLng.lng()}`} target="_blank">Directions</a>`,
        ];
        if (f.getProperty('msg')) {
          content.push(f.getProperty('msg'));
        }
        if (f.getProperty('emergency')) {
          content.push('<strong>Emergency</strong>');
        }
        if (f.getProperty('valid') === false) {
          content.push(
            '<strong>WARNING:',
            'The GPS fix is reported as invalid.',
            'The actual location might be different.</strong>',
          );
        }

        if (this.map && this.info) {
          this.info.setContent(content.join('<br>'));
          this.info.setPosition(event.latLng);
          this.info.open(map);
          this.currentName = f.getProperty('name');
          this.setMapStyle(this.map);
        }
      }
    });
  }

  private setMapStyle(map: google.maps.Map): void {
    map.data.setStyle(
      (feature: google.maps.Data.Feature): google.maps.Data.StyleOptions => {
        const type = feature.getGeometry().getType();
        switch (type) {
          case 'Point':
            return this.getFixStyle(feature);
          case 'LineString':
            return this.getTrackSyle(feature);
          default:
            return {};
        }
      },
    );
  }

  private getFixStyle(feature: google.maps.Data.Feature): google.maps.Data.StyleOptions {
    const now = Date.now();
    const ts = feature.getProperty('ts');
    const old = now - 5 * 3600 * 1000;
    const s = linearInterpolate(old, 10, now, 100, ts);
    let color = `hsl(111, ${s}%, 53%)`;
    let zIndex = 10;
    const age_hours = (now - ts) / (3600 * 1000);
    let opacity = age_hours > 12 ? 0.3 : 0.9;

    // Small circle by default.
    let scale = 3;
    let rotation = 0;
    let path: google.maps.SymbolPath | string = google.maps.SymbolPath.CIRCLE;
    let labelOrigin = new google.maps.Point(0, 3);
    let anchor: google.maps.Point | undefined;

    // Display an arrow when we have a bearing (last point).
    if (feature.getProperty('bearing') != null) {
      rotation = Number(feature.getProperty('bearing'));
      scale = 3;
      const ANCHOR_Y = 2;
      anchor = new google.maps.Point(0, ANCHOR_Y);
      path = google.maps.SymbolPath.FORWARD_CLOSED_ARROW;
      const rad = toRad(-rotation);
      // x1 = x0cos(θ) – y0sin(θ)
      // y1 = x0sin(θ) + y0cos(θ)
      const x = -5 * Math.sin(rad);
      const y = 5 * Math.cos(rad);
      labelOrigin = new google.maps.Point(x, y + ANCHOR_Y);
    }

    // Display speech bubble for messages and emergency.
    if (feature.getProperty('msg')) {
      scale = 1;
      anchor = new google.maps.Point(7, 9);
      labelOrigin = new google.maps.Point(0, 32);
      rotation = 0;
      path = SPEECH_BUBBLE;
      color = 'yellow';
      zIndex += 10;
    }

    if (feature.getProperty('emergency')) {
      scale = 1;
      anchor = new google.maps.Point(7, 9);
      labelOrigin = new google.maps.Point(0, 32);
      rotation = 0;
      path = SPEECH_BUBBLE;
      opacity = 1;
      color = 'red';
      zIndex += 10;
    }

    // Display pilot name.
    let label: google.maps.MarkerLabel | null = null;
    if (feature.getProperty('is_last_fix') === true) {
      if (this.displayNames) {
        const minutesOld = Math.round((now - ts) / (60 * 1000));
        const age =
          minutesOld < 60
            ? `${minutesOld}min`
            : `${Math.floor(minutesOld / 60)}h${String(minutesOld % 60).padStart(2, '0')}`;
        label = {
          color: 'black',
          text: feature.getProperty('name') + ' · ' + age,
          fontSize: '14.001px',
        };
      }
    }
    return {
      label,
      zIndex,
      cursor: 'zoom-in',
      icon: {
        path,
        rotation,
        fillColor: color,
        fillOpacity: opacity,
        strokeColor: 'black',
        strokeWeight: 1,
        strokeOpacity: opacity,
        anchor,
        labelOrigin,
        scale,
      },
    } as google.maps.Data.StyleOptions;
  }

  private getTrackSyle(feature: google.maps.Data.Feature): google.maps.Data.StyleOptions {
    const now = Date.now();
    const ts = feature.getProperty('first_ts');
    const age_hours = (now - ts) / (3600 * 1000);
    const opacity = age_hours > 12 ? 0.3 : 0.9;

    let strokeWeight = 1;
    if (feature.getProperty('name') && feature.getProperty('name') == this.currentName) {
      strokeWeight = 4;
    }
    return {
      strokeColor: '#555',
      strokeWeight,
      strokeOpacity: opacity,
      fillOpacity: opacity,
      zIndex: 10,
    };
  }

  protected render(): TemplateResult {
    return html`
      <link
        rel="stylesheet"
        href="https://cdn.jsdelivr.net/npm/line-awesome@1/dist/line-awesome/css/line-awesome.min.css"
      />
      <label
        ><input type="checkbox" ?checked=${this.displayNames} @change=${this.handleDisplayNames} /><i
          class="la la-user-tag la-2x"
        ></i
      ></label>
      <i
        class="la la-satellite-dish la-2x"
        style="cursor: pointer"
        @click=${(): void => void (document.location.href = '/devices.html')}
      ></i>
    `;
  }

  private handleDisplayNames(e: Event): void {
    const show = (e.target as HTMLInputElement).checked;
    store.dispatch(setDisplayLiveNames(show));
    // The style depends on displayNames.
    if (this.map_) {
      this.setMapStyle(this.map_);
    }
  }
}