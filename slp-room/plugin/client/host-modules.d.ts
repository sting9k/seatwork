// Paseo supplies these modules to plugin code that runs in the app. They are declared loosely here so the
// plugin's own logic is type-checked without installing React Native for it.
declare module "react";
declare module "react/jsx-runtime";
declare module "react-native";
declare module "@tanstack/react-query";
