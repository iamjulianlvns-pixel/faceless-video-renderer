import express from "express";
import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-client-token, x-render-secret"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({
  limit: "2mb"
}));

const PORT = process.env.PORT || 8080;
const RENDER_SECRET = process.env.RENDER_SECRET;
const CLIENT_RENDER_TOKEN =
  process.env.CLIENT_RENDER_TOKEN;
const OUTPUT_DIR = path.join(
  os.tmpdir(),
  "faceless-renderer-outputs"
);

function validateSecret(req) {
  const suppliedSecret =
    req.headers["x-render-secret"];

  const suppliedClientToken =
    req.headers["x-client-token"];

  if (
    RENDER_SECRET &&
    suppliedSecret === RENDER_SECRET
  ) {
    return;
  }

  if (
    CLIENT_RENDER_TOKEN &&
    suppliedClientToken === CLIENT_RENDER_TOKEN
  ) {
    return;
  }

  const error = new Error("Unauthorized");
  error.status = 401;
  throw error;
}

async function downloadFile(url, destination) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to download file: ${response.status}`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  await fs.writeFile(destination, buffer);
}

async function getMediaDuration(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath
  ]);

  const duration = Number(stdout.trim());

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Unable to determine media duration");
  }

  return duration;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "faceless-video-renderer",
    ffmpeg: true
  });
});
app.get("/test-render", async (req, res) => {
  const testFilename = "railway-test.mp4";
  const testPath = path.join(
    OUTPUT_DIR,
    testFilename
  );

  try {
    await fs.mkdir(OUTPUT_DIR, {
      recursive: true
    });

    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=1280x720:d=5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-movflags",
      "+faststart",
      testPath
    ]);

    res.json({
      success: true,
      message: "FFmpeg successfully created a real MP4",
      output_url:
        `${req.protocol}://${req.get("host")}/files/${testFilename}`
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
app.get("/files/:filename", async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);

    if (!filename.endsWith(".mp4")) {
      return res.status(400).json({
        error: "Invalid file"
      });
    }

    const filePath = path.join(
      OUTPUT_DIR,
      filename
    );

    await fs.access(filePath);

    res.sendFile(filePath);
  } catch {
    res.status(404).json({
      error: "File not found"
    });
  }
});

app.post("/render", async (req, res) => {
  let workDir;

  try {
    validateSecret(req);

    const {
  job_id,
  scenes,
  audio_url,
  subtitle_url,
  resolution = "1920x1080",
  fps = 30
} = req.body;

const normalizedFps = Number(
  String(fps).replace(/fps$/i, "").trim()
);

if (!Number.isFinite(normalizedFps) || normalizedFps <= 0) {
  throw new Error("Invalid framerate");
}

    if (!job_id) {
      return res.status(400).json({
        error: "job_id is required"
      });
    }

    if (!Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({
        error: "At least one scene is required"
      });
    }

    if (!audio_url) {
      return res.status(400).json({
        error: "audio_url is required"
      });
    }

    await fs.mkdir(OUTPUT_DIR, {
      recursive: true
    });

    workDir = path.join(
      os.tmpdir(),
      `render-${crypto.randomUUID()}`
    );

    await fs.mkdir(workDir, {
      recursive: true
    });

    const sceneFiles = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];

      if (!scene.image_url) {
        throw new Error(
          `Scene ${i + 1} has no image_url`
        );
      }

      const imagePath = path.join(
        workDir,
        `scene-${i + 1}.jpg`
      );

      await downloadFile(
        scene.image_url,
        imagePath
      );

      sceneFiles.push({
        path: imagePath,
        duration: Math.max(
          Number(scene.duration) || 1,
          0.1
        )
      });
    }

    const audioPath = path.join(
      workDir,
      "voiceover.mp3"
    );

    await downloadFile(
      audio_url,
      audioPath
    );

    const audioDuration =
      await getMediaDuration(audioPath);

    const sceneDurationTotal =
      sceneFiles.reduce(
        (total, scene) =>
          total + scene.duration,
        0
      );

    if (
      sceneDurationTotal <
      audioDuration
    ) {
      sceneFiles[
        sceneFiles.length - 1
      ].duration +=
        audioDuration -
        sceneDurationTotal;
    }

    let subtitlePath = null;

    if (subtitle_url) {
      subtitlePath = path.join(
        workDir,
        "subtitles.vtt"
      );

      await downloadFile(
        subtitle_url,
        subtitlePath
      );
    }

    const concatPath = path.join(
      workDir,
      "images.txt"
    );

    let concatText = "";

    for (const scene of sceneFiles) {
      concatText += `file '${scene.path}'\n`;
      concatText += `duration ${scene.duration}\n`;
    }

    concatText +=
      `file '${sceneFiles[sceneFiles.length - 1].path}'\n`;

    await fs.writeFile(
      concatPath,
      concatText
    );

    const [width, height] =
      resolution
        .split("x")
        .map(Number);

    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height)
    ) {
      throw new Error(
        "Invalid resolution"
      );
    }

    const silentVideoPath = path.join(
      workDir,
      "silent.mp4"
    );

    const finalFilename =
      `${job_id}.mp4`;

    const finalVideoPath = path.join(
      OUTPUT_DIR,
      finalFilename
    );

    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatPath,
      "-vf",
`format=yuv420p,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
"-r",
String(normalizedFps),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-movflags",
      "+faststart",
      silentVideoPath
    ]);

    const videoInputArgs = [
      "-y",
      "-i",
      silentVideoPath,
      "-i",
      audioPath
    ];

    if (subtitlePath) {
      videoInputArgs.push(
        "-i",
        subtitlePath
      );
    }

    const ffmpegArgs = [
      ...videoInputArgs,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0"
    ];

    if (subtitlePath) {
      ffmpegArgs.push(
        "-vf",
        `subtitles=${subtitlePath}`
      );
    }

    ffmpegArgs.push(
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
      finalVideoPath
    );

    await execFileAsync(
      "ffmpeg",
      ffmpegArgs
    );

    return res.json({
      success: true,
      job_id,
      status: "completed",
      message: "Video rendered successfully",
      duration: audioDuration,
      output_url:
        `${req.protocol}://${req.get("host")}/files/${finalFilename}`
    });

  } catch (error) {
    console.error(error);

    return res.status(
      error.status || 500
    ).json({
      success: false,
      error: error.message
    });

  } finally {
    if (workDir) {
      await fs.rm(
        workDir,
        {
          recursive: true,
          force: true
        }
      ).catch(() => {});
    }
  }
});

app.listen(PORT, () => {
  console.log(
    `Faceless Video Renderer listening on port ${PORT}`
  );
});
