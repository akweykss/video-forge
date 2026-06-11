import { Config } from "@remotion/cli/config";

// ProRes 4444 with alpha channel for transparent overlays
Config.setVideoImageFormat("png");         // Required for alpha support
Config.setPixelFormat("yuva444p10le");      // 10-bit alpha channel
Config.setCodec("prores");
Config.setProResProfile("4444");
Config.setOverwriteOutput(true);
