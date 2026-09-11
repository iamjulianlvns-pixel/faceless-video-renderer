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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 8080);
const RENDER_SECRET = process.env.RENDER_SECRET;
const CLIENT_RENDER_TOKEN = process.env.CLIENT_RENDER_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TRANSCRIPTION_MODEL = process.env.TRANSCRIPTION_MODEL || "whisper-1";
const DEFAULT_LANGUAGE = process.env.SUBTITLE_LANGUAGE || "en";

const OUTPUT_DIR = path.join(
  os.tmpdir(),
  "faceless-renderer-outputs"
);

function validateSecret(req) {
  const suppliedSecret = req.headers["x-render-secret"];
  const suppliedClientToken = req.headers["x-client-token"];

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
  const response = await fetch(url, {
    redirect: "follow"
  });

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

  if (
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    throw new Error(
      `Unable to determine media duration: ${filePath}`
    );
  }

  return duration;
}

function getOutputSize(
  aspectRatio,
  requestedResolution
) {
  if (requestedResolution) {
    const match = String(requestedResolution).match(
      /^(\d+)x(\d+)$/
    );

    if (!match) {
      throw new Error(
        "Invalid resolution. Use WIDTHxHEIGHT."
      );
    }

    return {
      width: Number(match[1]),
      height: Number(match[2])
    };
  }

  switch (aspectRatio) {
    case "9:16":
      return {
        width: 1080,
        height: 1920
      };

    case "1:1":
      return {
        width: 1080,
        height: 1080
      };

    case "16:9":
    default:
      return {
        width: 1920,
        height: 1080
      };
  }
}

function normalizeScenes(
  scenes,
  audioDuration
) {
  const raw = scenes.map((scene) => {
    const requested = Number(scene.duration);

    return Number.isFinite(requested) &&
      requested > 0
      ? requested
      : 0;
  });

  const suppliedTotal = raw.reduce(
    (a, b) => a + b,
    0
  );

  const fallbackDuration =
    audioDuration / scenes.length;

  let durations;

  if (suppliedTotal > 0) {
    const scale =
      audioDuration / suppliedTotal;

    durations = raw.map((duration) =>
      duration > 0
        ? duration * scale
        : fallbackDuration
    );
  } else {
    durations = scenes.map(
      () => fallbackDuration
    );
  }

  const total = durations.reduce(
    (a, b) => a + b,
    0
  );

  durations[durations.length - 1] +=
    audioDuration - total;

  return durations.map((duration) =>
    Math.max(0.25, duration)
  );
}

function assTime(seconds) {
  const totalCs = Math.max(
    0,
    Math.round(seconds * 100)
  );

  const cs = totalCs % 100;

  const totalSeconds =
    Math.floor(totalCs / 100);

  const s = totalSeconds % 60;

  const totalMinutes =
    Math.floor(totalSeconds / 60);

  const m = totalMinutes % 60;

  const h = Math.floor(totalMinutes / 60);

  return `${h}:${String(m).padStart(
    2,
    "0"
  )}:${String(s).padStart(
    2,
    "0"
  )}.${String(cs).padStart(
    2,
    "0"
  )}`;
}

function escapeAss(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, " ")
    .trim();
}

function chunkWords(
  words,
  maxWords = 8
) {
  const chunks = [];
  let current = [];

  for (const word of words) {
    const clean = String(
      word.word ?? word.text ?? ""
    ).trim();

    if (!clean) {
      continue;
    }

    current.push({
      text: clean,
      start: Number(word.start),
      end: Number(word.end)
    });

    const endsSentence =
      /[.!?…]$/.test(clean);

    if (
      current.length >= maxWords ||
      endsSentence
    ) {
      chunks.push(current);
      current = [];
    }
  }

  if (current.length) {
    chunks.push(current);
  }

  return chunks;
}

function buildSubtitleAss(
  transcription,
  width,
  height
) {
  let words = Array.isArray(
    transcription.words
  )
    ? transcription.words
    : [];

  if (
    !words.length &&
    Array.isArray(transcription.segments)
  ) {
    words = transcription.segments.map(
      (segment) => ({
        text: segment.text,
        start: segment.start,
        end: segment.end
      })
    );
  }

  if (!words.length) {
    throw new Error(
      "Transcription returned no timestamped speech"
    );
  }

  const chunks = chunkWords(
    words,
    width < 1200 ? 6 : 8
  );

  const fontSize =
    width >= 1800
      ? 52
      : width >= 1000
        ? 44
        : 38;

  const marginV =
    height > width
      ? 150
      : 90;

  const header =
    `[Script Info]\n` +
    `ScriptType: v4.00+\n` +
    `PlayResX: ${width}\n` +
    `PlayResY: ${height}\n` +
    `WrapStyle: 2\n` +
    `ScaledBorderAndShadow: yes\n\n` +
    `[V4+ Styles]\n` +
    `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Documentary,DejaVu Sans,${fontSize},&H10FFFFFF,&H10FFFFFF,&H78000000,&H90000000,0,0,0,0,100,100,0,0,1,2,1,2,${Math.round(
      width * 0.08
    )},${Math.round(
      width * 0.08
    )},${marginV},1\n\n` +
    `[Events]\n` +
    `Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  const dialogue = chunks
    .map((chunk) => {
      const start = Math.max(
        0,
        Number(chunk[0].start) || 0
      );

      const end = Math.max(
        start + 0.05,
        Number(
          chunk[chunk.length - 1].end
        ) || start + 1
      );

      const text = escapeAss(
        chunk
          .map((word) => word.text)
          .join(" ")
      );

      return (
        `Dialogue: 0,` +
        `${assTime(start)},` +
        `${assTime(end)},` +
        `Documentary,,0,0,0,,` +
        `{\\fad(180,220)}` +
        text
      );
    })
    .join("\n");

  return header + dialogue + "\n";
}

async function transcribeAudio(
  audioPath,
  language
) {
  if (!OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is not configured on Railway"
    );
  }

  const buffer =
    await fs.readFile(audioPath);

  if (
    buffer.length >
    25 * 1024 * 1024
  ) {
    throw new Error(
      "Voiceover is larger than the transcription upload limit"
    );
  }

  const form = new FormData();

  form.append(
    "file",
    new Blob(
      [buffer],
      {
        type: "audio/mpeg"
      }
    ),
    "voiceover.mp3"
  );

  form.append(
    "model",
    TRANSCRIPTION_MODEL
  );

  form.append(
    "response_format",
    "verbose_json"
  );

  form.append(
    "timestamp_granularities[]",
    "word"
  );

  form.append(
    "temperature",
    "0"
  );

  if (language) {
    form.append(
      "language",
      language
    );
  }

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${OPENAI_API_KEY}`
      },
      body: form
    }
  );

  const bodyText =
    await response.text();

  let body;

  try {
    body = JSON.parse(
      bodyText
    );
  } catch {
    body = {
      error: {
        message: bodyText
      }
    };
  }

  if (!response.ok) {
    throw new Error(
      `OpenAI transcription failed: ${
        body?.error?.message ||
        response.statusText
      }`
    );
  }

  return body;
}

async function createSceneVideo({
  inputPath,
  outputPath,
  duration,
  width,
  height,
  isImage
}) {
  const inputArgs = isImage
    ? [
        "-loop",
        "1",
        "-i",
        inputPath
      ]
    : [
        "-stream_loop",
        "-1",
        "-i",
        inputPath
      ];

  const filter = [
    "split=2[bg][fg]",

    `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},` +
      `gblur=sigma=22,` +
      `eq=brightness=-0.16:saturation=0.82[bg2]`,

    `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg2]`,

    `[bg2][fg2]overlay=(W-w)/2:(H-h)/2,` +
      `format=yuv420p,` +
      `settb=AVTB[v]`
  ].join(";");

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      ...inputArgs,

      "-filter_complex",
      filter,

      "-map",
      "[v]",

      "-t",
      String(duration),

      "-r",
      "30",

      "-an",

      "-c:v",
      "libx264",

      "-preset",
      "veryfast",

      "-crf",
      "19",

      "-pix_fmt",
      "yuv420p",

      "-movflags",
      "+faststart",

      outputPath
    ]
  );
}

async function crossfadeScenes(
  scenePaths,
  durations,
  outputPath,
  transitionDuration = 0.45
) {
  if (scenePaths.length === 1) {
    await fs.copyFile(
      scenePaths[0],
      outputPath
    );

    return;
  }

  const inputs = [];
  const graph = [];

  for (
    let i = 0;
    i < scenePaths.length;
    i++
  ) {
    inputs.push(
      "-i",
      scenePaths[i]
    );

    graph.push(
      `[${i}:v]settb=AVTB,format=yuv420p[v${i}]`
    );
  }

  let currentLabel = "v0";
  let currentDuration =
    durations[0];

  for (
    let i = 1;
    i < scenePaths.length;
    i++
  ) {
    const fade = Math.min(
      transitionDuration,
      Math.max(
        0.05,
        durations[i - 1] / 3
      ),
      Math.max(
        0.05,
        durations[i] / 3
      )
    );

    const offset = Math.max(
      0,
      currentDuration - fade
    );

    const outLabel =
      `xf${i}`;

    graph.push(
      `[${currentLabel}][v${i}]` +
      `xfade=transition=fade:` +
      `duration=${fade.toFixed(3)}:` +
      `offset=${offset.toFixed(3)},` +
      `format=yuv420p[${outLabel}]`
    );

    currentLabel =
      outLabel;

    currentDuration =
      currentDuration +
      durations[i] -
      fade;
  }

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      ...inputs,

      "-filter_complex",
      graph.join(";"),

      "-map",
      `[${currentLabel}]`,

      "-c:v",
      "libx264",

      "-preset",
      "veryfast",

      "-crf",
      "18",

      "-pix_fmt",
      "yuv420p",

      "-movflags",
      "+faststart",

      outputPath
    ]
  );
}

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "faceless-video-renderer",
      ffmpeg: true,
      transcription:
        Boolean(OPENAI_API_KEY),
      transcription_model:
        TRANSCRIPTION_MODEL
    });
  }
);

app.get(
  "/test-render",
  async (req, res) => {
    const testFilename =
      "railway-test.mp4";

    const testPath =
      path.join(
        OUTPUT_DIR,
        testFilename
      );

    try {
      await fs.mkdir(
        OUTPUT_DIR,
        {
          recursive: true
        }
      );

      await execFileAsync(
        "ffmpeg",
        [
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

          "-b:a",
          "192k",

          "-shortest",

          "-movflags",
          "+faststart",

          testPath
        ]
      );

      res.json({
        success: true,
        message:
          "FFmpeg successfully created a real MP4",
        output_url:
          `${req.protocol}://${req.get(
            "host"
          )}/files/${testFilename}`
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

app.get(
  "/files/:filename",
  async (req, res) => {
    try {
      const filename =
        path.basename(
          req.params.filename
        );

      if (
        !filename.endsWith(".mp4")
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid file"
          });
      }

      const filePath =
        path.join(
          OUTPUT_DIR,
          filename
        );

      await fs.access(
        filePath
      );

      res.sendFile(
        filePath
      );
    } catch {
      res
        .status(404)
        .json({
          error:
            "File not found"
        });
    }
  }
);

app.post(
  "/render",
  async (req, res) => {
    let workDir;

    try {
      validateSecret(req);

      const {
        job_id,
        scenes,
        audio_url,
        subtitle_url,
        subtitle_language =
          DEFAULT_LANGUAGE,
        resolution,
        aspect_ratio =
          "16:9",
        fps = 30,
        subtitles = true
      } = req.body;

      if (!job_id) {
        return res
          .status(400)
          .json({
            error:
              "job_id is required"
          });
      }

      if (
        !Array.isArray(scenes) ||
        scenes.length === 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "At least one scene is required"
          });
      }

      if (!audio_url) {
        return res
          .status(400)
          .json({
            error:
              "audio_url is required"
          });
      }

      const normalizedFps =
        Number(
          String(fps)
            .replace(
              /fps$/i,
              ""
            )
            .trim()
        );

      if (
        !Number.isFinite(
          normalizedFps
        ) ||
        normalizedFps <= 0
      ) {
        throw new Error(
          "Invalid framerate"
        );
      }

      const {
        width,
        height
      } = getOutputSize(
        aspect_ratio,
        resolution
      );

      await fs.mkdir(
        OUTPUT_DIR,
        {
          recursive: true
        }
      );

      workDir =
        path.join(
          os.tmpdir(),
          `render-${crypto.randomUUID()}`
        );

      await fs.mkdir(
        workDir,
        {
          recursive: true
        }
      );

      const audioPath =
        path.join(
          workDir,
          "voiceover.mp3"
        );

      await downloadFile(
        audio_url,
        audioPath
      );

      const audioDuration =
        await getMediaDuration(
          audioPath
        );

      const durations =
        normalizeScenes(
          scenes,
          audioDuration
        );

      const scenePaths = [];

      for (
        let i = 0;
        i < scenes.length;
        i++
      ) {
        const scene =
          scenes[i];

        const mediaUrl =
          scene.video_url ||
          scene.image_url;

        if (!mediaUrl) {
          throw new Error(
            `Scene ${i + 1} has no video_url or image_url`
          );
        }

        const extension =
          scene.video_url
            ? ".mp4"
            : ".jpg";

        const inputPath =
          path.join(
            workDir,
            `source-${i + 1}${extension}`
          );

        const outputPath =
          path.join(
            workDir,
            `scene-${i + 1}.mp4`
          );

        await downloadFile(
          mediaUrl,
          inputPath
        );

        await createSceneVideo({
          inputPath,
          outputPath,
          duration:
            durations[i],
          width,
          height,
          isImage:
            !scene.video_url
        });

        scenePaths.push(
          outputPath
        );
      }

      const visualPath =
        path.join(
          workDir,
          "visual.mp4"
        );

      await crossfadeScenes(
        scenePaths,
        durations,
        visualPath
      );

      let subtitlePath =
        null;

      if (
        subtitles &&
        subtitle_url
      ) {
        subtitlePath =
          path.join(
            workDir,
            "subtitles.ass"
          );

        await downloadFile(
          subtitle_url,
          subtitlePath
        );
      } else if (
        subtitles
      ) {
        const transcription =
          await transcribeAudio(
            audioPath,
            subtitle_language
          );

        subtitlePath =
          path.join(
            workDir,
            "subtitles.ass"
          );

        const ass =
          buildSubtitleAss(
            transcription,
            width,
            height
          );

        await fs.writeFile(
          subtitlePath,
          ass,
          "utf8"
        );
      }

      const finalFilename =
        `${job_id}.mp4`;

      const finalVideoPath =
        path.join(
          OUTPUT_DIR,
          finalFilename
        );

      const finalArgs = [
        "-y",

        "-i",
        visualPath,

        "-i",
        audioPath
      ];

      if (subtitlePath) {
        finalArgs.push(
          "-vf",
          `ass=${subtitlePath}`
        );
      }

      finalArgs.push(
        "-map",
        "0:v:0",

        "-map",
        "1:a:0",

        "-r",
        String(
          normalizedFps
        ),

        "-c:v",
        "libx264",

        "-preset",
        "medium",

        "-crf",
        "18",

        "-pix_fmt",
        "yuv420p",

        "-profile:v",
        "high",

        "-level",
        "4.1",

        "-c:a",
        "aac",

        "-b:a",
        "192k",

        "-af",
        "loudnorm=I=-14:TP=-1.5:LRA=11",

        "-shortest",

        "-movflags",
        "+faststart",

        finalVideoPath
      );

      await execFileAsync(
        "ffmpeg",
        finalArgs
      );

      return res.json({
        success: true,
        job_id,
        status:
          "completed",
        message:
          "Video rendered successfully",
        duration:
          audioDuration,
        resolution:
          `${width}x${height}`,
        aspect_ratio,
        fps:
          normalizedFps,
        subtitles:
          Boolean(
            subtitlePath
          ),
        output_url:
          `${req.protocol}://${req.get(
            "host"
          )}/files/${finalFilename}`
      });
    } catch (error) {
      console.error(error);

      return res
        .status(
          error.status || 500
        )
        .json({
          success: false,
          error:
            error.message
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
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Faceless Video Renderer listening on port ${PORT}`
    );
  }
);
