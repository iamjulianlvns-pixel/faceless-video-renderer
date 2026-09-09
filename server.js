import express from "express";
import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const app = express();

app.use(express.json({
  limit: "2mb"
}));

const PORT = process.env.PORT || 8080;
const RENDER_SECRET = process.env.RENDER_SECRET;

function validateSecret(req) {
  if (!RENDER_SECRET) {
    throw new Error("RENDER_SECRET is not configured");
  }

  const suppliedSecret = req.headers["x-render-secret"];

  if (suppliedSecret !== RENDER_SECRET) {
    const error = new Error("Unauthorized");
    error.status = 401;
    throw error;
  }
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

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "faceless-video-renderer"
  });
});

app.post("/render", async (req, res) => {
  try {
    validateSecret(req);

    const {
      job_id,
      scenes,
      audio_url,
      resolution = "1920x1080",
      fps = 30
    } = req.body;

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

    const workDir = path.join(
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

    const concatPath = path.join(
      workDir,
      "images.txt"
    );

    let concatText = "";

    for (const scene of sceneFiles) {
      concatText += `file '${scene.path}'\n`;
      concatText += `duration ${scene.duration}\n`;
    }

    concatText += `file '${sceneFiles[sceneFiles.length - 1].path}'\n`;

    await fs.writeFile(
      concatPath,
      concatText
    );

    const [width, height] =
      resolution.split("x").map(Number);

    const silentVideoPath = path.join(
      workDir,
      "silent.mp4"
    );

    const finalVideoPath = path.join(
      workDir,
      "output.mp4"
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
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
      "-r",
      String(fps),
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

    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      silentVideoPath,
      "-i",
      audioPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
      finalVideoPath
    ]);

    return res.json({
      success: true,
      job_id,
      status: "completed",
      message: "Video rendered successfully",
      output_path: finalVideoPath
    });

  } catch (error) {
    console.error(error);

    return res.status(
      error.status || 500
    ).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `Faceless Video Renderer listening on port ${PORT}`
  );
});
