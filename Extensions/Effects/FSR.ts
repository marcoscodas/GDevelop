// resources/GDJS/Runtime-sources/Extensions/Effects/FSR.ts
//
// AMD FidelityFX-style upscaling filter (single-pass RCAS-like sharpening + edge-aware upscale kernel).
// NOTE: True performance gains require rendering the scene at a lower internal resolution
// and then applying this filter on the upscaled blit (see step 2).
//
// Portions of the sharpening kernel are informed by AMD RCAS (MIT); this is not verbatim AMD code.
// Attribution: © 2021-2024 Advanced Micro Devices, Inc. MIT License.

namespace gdjs {
  const FSR_FRAGMENT = `
  precision mediump float;
  varying vec2 vTextureCoord;
  uniform sampler2D uSampler;
  uniform vec2 inputSize;     // size of the source texture (internal RT)
  uniform vec2 outputSize;    // size of final screen
  uniform float sharpness;    // 0..1
  uniform float enableRCAS;   // 0 or 1

  // Edge-aware upscale sample (simple EASU-inspired kernel; not full AMD macro expand)
  vec4 easuSample(vec2 uv) {
    // 2x2 + diagonals kernel – cheap edge adaptivity
    vec2 px = 1.0 / inputSize;
    vec4 c  = texture2D(uSampler, uv);
    vec4 n  = texture2D(uSampler, uv + vec2(0.0, -px.y));
    vec4 s  = texture2D(uSampler, uv + vec2(0.0,  px.y));
    vec4 e  = texture2D(uSampler, uv + vec2( px.x, 0.0));
    vec4 w  = texture2D(uSampler, uv + vec2(-px.x, 0.0));
    vec4 ne = texture2D(uSampler, uv + vec2( px.x, -px.y));
    vec4 nw = texture2D(uSampler, uv + vec2(-px.x, -px.y));
    vec4 se = texture2D(uSampler, uv + vec2( px.x,  px.y));
    vec4 sw = texture2D(uSampler, uv + vec2(-px.x,  px.y));

    // Edge magnitude
    vec3 gx = (e.rgb - w.rgb) + 0.7071*(ne.rgb + se.rgb - nw.rgb - sw.rgb);
    vec3 gy = (s.rgb - n.rgb) + 0.7071*(sw.rgb + se.rgb - nw.rgb - ne.rgb);
    float edge = clamp((dot(gx,gx)+dot(gy,gy))*0.25, 0.0, 1.0);

    // Edge adaptive mix between bilinear (softer) and unsharp mask (sharper)
    vec4 bil = c*0.25 + (n+s+e+w)*0.1875 + (ne+nw+se+sw)*0.0625; // 9-tap approx
    vec4 sharp = c + (c - bil) * (0.5 + sharpness*1.5);
    return mix(bil, sharp, edge);
  }

  // RCAS-ish final contrast adaptive sharpening
  vec4 rcas(vec2 uv, vec4 src) {
    if (enableRCAS < 0.5) return src;
    vec2 px = 1.0 / outputSize;
    vec3 c  = src.rgb;
    vec3 a  = texture2D(uSampler, uv + vec2(0.0, -px.y)).rgb;
    vec3 b  = texture2D(uSampler, uv + vec2(0.0,  px.y)).rgb;
    vec3 d  = texture2D(uSampler, uv + vec2( px.x, 0.0)).rgb;
    vec3 e  = texture2D(uSampler, uv + vec2(-px.x, 0.0)).rgb;

    // Local contrast estimate and adaptive gain
    vec3 mn = min(min(a,b), min(d,e));
    vec3 mx = max(max(a,b), max(d,e));
    vec3 rng = max(mx - mn, vec3(1e-3));
    float gain = clamp(0.25 + sharpness * 0.75, 0.05, 1.0);

    vec3 detail = c - 0.25*(a+b+d+e);
    vec3 outc = c + gain * detail / rng;
    return vec4(clamp(outc, 0.0, 1.0), src.a);
  }

  void main() {
    // Map current output pixel to source UV with scale
    // When internal scaling is active, inputSize < outputSize
    vec2 scale = inputSize / max(outputSize, vec2(1.0));
    vec2 uv = vTextureCoord * scale; // sample from smaller source
    vec4 up = easuSample(uv);
    gl_FragColor = rcas(vTextureCoord, up);
  }`;

  // Effect descriptor expected by GDevelop runtime
  export const FSR = {
    name: 'FSR',
    displayName: 'FidelityFX Super Resolution (FSR)',
    category: 'Upscale',
    description:
      'Render your scene at a lower internal resolution and upscale with edge-aware filtering and optional RCAS sharpening.',
    helpUrl: '',
    parameters: [
      {
        name: 'Sharpness',
        label: 'Sharpness',
        description: 'Sharpening amount (0..1)',
        type: 'number',
        defaultValue: 0.3,
        min: 0,
        max: 1,
        step: 0.01,
      },
      {
        name: 'Enable RCAS',
        label: 'Enable RCAS',
        description: 'Apply an additional Robust Contrast Adaptive Sharpening pass',
        type: 'boolean',
        defaultValue: true,
      },
    ],

    // Create the PIXI filter when the effect is added
    create: function (effectData: any, runtimeScene: any) {
      const sharp = effectData.doubleParameters['Sharpness'] ?? 0.3;
      const enable = !!(effectData.booleanParameters['Enable RCAS'] ?? true);

      const renderer = runtimeScene.getRenderer();
      const pixiRenderer = renderer.getPIXIRenderer();

      const uniforms = {
        inputSize: new Float32Array([pixiRenderer.screen.width, pixiRenderer.screen.height]),
        outputSize: new Float32Array([pixiRenderer.screen.width, pixiRenderer.screen.height]),
        sharpness: sharp,
        enableRCAS: enable ? 1.0 : 0.0,
      };

      const filter = new (PIXI as any).Filter(undefined, FSR_FRAGMENT, uniforms);
      (filter as any).__gdjs_isFsr = true;

      return filter;
    },

    // Called every frame before rendering the layer
    update: function (filter: PIXI.Filter, effectData: any, layer: any, runtimeScene: any) {
      const renderer = runtimeScene.getRenderer();
      const pixiRenderer = renderer.getPIXIRenderer();
      const u = filter.uniforms as any;

      // outputSize is the current screen, inputSize will be set by the internal-scaling pass (step 2)
      u.outputSize[0] = pixiRenderer.screen.width;
      u.outputSize[1] = pixiRenderer.screen.height;

      // If internalScale metadata is present on the scene renderer, pull it (set in step 2)
      const internalSize = (renderer as any)._fsrInternalSize;
      if (internalSize) {
        u.inputSize[0] = internalSize[0];
        u.inputSize[1] = internalSize[1];
      } else {
        // Fallback: no internal scaling – treat input == output so it behaves as a smart sharpen
        u.inputSize[0] = u.outputSize[0];
        u.inputSize[1] = u.outputSize[1];
      }

      u.sharpness = effectData.doubleParameters['Sharpness'] ?? 0.3;
      u.enableRCAS = (effectData.booleanParameters['Enable RCAS'] ?? true) ? 1.0 : 0.0;
    },
  };

  // Register the effect in the Pixi filters toolbox
  (gdjs as any).PixiFiltersTools.registerEffect('FSR', FSR);
}
