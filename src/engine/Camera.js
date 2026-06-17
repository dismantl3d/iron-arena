// Camera maps world space -> screen space by transforming a single "world"
// Container. Everything in the world is added to camera.world; the camera
// moves that container so the followed point stays centered on screen.

export class Camera {
  constructor(world, screen) {
    this.world = world; // the Container holding all world-space objects
    this.screen = screen; // { width, height }, updated on resize
    this.x = 0; // world coordinate the camera is centered on
    this.y = 0;
    this.zoom = 1;
    this.target = null; // object with { x, y } to track each frame
  }

  // Center the camera on a world position.
  moveTo(x, y) {
    this.x = x;
    this.y = y;
  }

  // Follow any object exposing { x, y } (e.g. a Tank). The camera re-reads the
  // target's position every frame in apply().
  follow(target) {
    this.target = target;
  }

  // Convert a screen (CSS pixel) position into world coordinates. Inverse of
  // the transform applied in apply(). Used e.g. to aim at the cursor.
  screenToWorld(sx, sy) {
    return {
      x: (sx - this.screen.width / 2) / this.zoom + this.x,
      y: (sy - this.screen.height / 2) / this.zoom + this.y,
    };
  }

  // Apply the current camera state to the world container. Call once per frame
  // after positions update.
  apply() {
    if (this.target) {
      this.x = this.target.x;
      this.y = this.target.y;
    }
    this.world.scale.set(this.zoom);
    this.world.position.set(
      this.screen.width / 2 - this.x * this.zoom,
      this.screen.height / 2 - this.y * this.zoom,
    );
  }
}
