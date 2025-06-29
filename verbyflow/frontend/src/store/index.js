import { createStore } from 'vuex'
import callModule from './modules/call'
import audioModule from './modules/audio'
import userModule from './modules/user'
import notificationModule from './modules/notification'

export default createStore({
  modules: {
    call: callModule,
    audio: audioModule,
    user: userModule,
    notification: notificationModule
  }
})
