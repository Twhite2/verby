<template>
  <div class="visualizer-container">
    <div class="bars-container">
      <div 
        v-for="(bar, index) in bars" 
        :key="index" 
        class="bar"
        :style="{ 
          height: `${bar}%`,
          backgroundColor: getBarColor(bar)
        }"
      ></div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'AudioVisualizer',
  props: {
    audioLevel: {
      type: Number,
      default: 0
    },
    barCount: {
      type: Number,
      default: 16
    },
    isInput: {
      type: Boolean,
      default: true
    }
  },
  data() {
    return {
      bars: [],
      animationId: null
    };
  },
  watch: {
    audioLevel: {
      handler(newLevel) {
        this.updateBars(newLevel);
      },
      immediate: true
    }
  },
  methods: {
    updateBars(level) {
      // Create random visualization based on audio level
      const newBars = [];
      const baseHeight = level * 100;
      
      for (let i = 0; i < this.barCount; i++) {
        // Create a wave-like pattern with some randomness
        let variance = Math.random() * 30 - 15;
        let height = baseHeight + variance;
        
        // Center bars should be taller
        const centerEffect = Math.abs(i - this.barCount / 2) / (this.barCount / 2);
        height = height * (1 - centerEffect * 0.5);
        
        // Ensure height is within bounds
        height = Math.max(0, Math.min(100, height));
        
        newBars.push(height);
      }
      
      this.bars = newBars;
    },
    getBarColor(height) {
      // Color gradient based on height
      const hue = this.isInput ? 200 : 120; // Blue for input, Green for output
      const saturation = 80;
      const lightness = Math.max(40, 60 - height * 0.2);
      
      return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    }
  }
}
</script>

<style scoped>
.visualizer-container {
  width: 100%;
  height: 60px;
  background-color: rgba(0, 0, 0, 0.03);
  border-radius: 4px;
  padding: 5px;
  box-sizing: border-box;
}

.bars-container {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  height: 100%;
  width: 100%;
}

.bar {
  flex: 1;
  margin: 0 1px;
  border-radius: 2px 2px 0 0;
  transition: height 0.1s ease;
}
</style>
