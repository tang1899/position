<script setup></script>

<template>
  <router-view />
</template>

<style>
html,
body,
#app {
  height: 100%;
  margin: 0;
}

html {
  -webkit-text-size-adjust: 100%;
}

#app {
  box-sizing: border-box;
  padding:
    env(safe-area-inset-top)
    env(safe-area-inset-right)
    env(safe-area-inset-bottom)
    env(safe-area-inset-left);
}

body {
  font-family:
    'PingFang SC',
    'Microsoft YaHei',
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
  background: #f1ebdf;
  color: #241f1a;
  -webkit-font-smoothing: antialiased;
  overscroll-behavior: none;
}
</style>
