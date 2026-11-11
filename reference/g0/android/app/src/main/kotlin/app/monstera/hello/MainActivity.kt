package app.monstera.hello

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

private const val TAG = "MonsteraHello"

class MainActivity : ComponentActivity() {

    // Last lifecycle callback seen; shown on screen and logged for Device Lab log capture.
    private var lastEvent by mutableStateOf("onCreate")

    private fun record(event: String) {
        lastEvent = event
        Log.i(TAG, "lifecycle: $event")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        record("onCreate")
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    HelloScreen(lifecycleEvent = lastEvent)
                }
            }
        }
    }

    override fun onStart() { super.onStart(); record("onStart") }
    override fun onResume() { super.onResume(); record("onResume") }
    override fun onPause() { record("onPause"); super.onPause() }
    override fun onStop() { record("onStop"); super.onStop() }
    override fun onDestroy() { record("onDestroy"); super.onDestroy() }
}

@Composable
fun HelloScreen(lifecycleEvent: String) {
    // rememberSaveable survives rotation and process-death restore.
    var taps by rememberSaveable { mutableStateOf(0) }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("MONSTERA", style = MaterialTheme.typography.headlineLarge)
        Text("Android Hello World (Kotlin + Compose)")
        Button(onClick = { taps++ }) { Text("Tap me") }
        Text("Taps: $taps")
        Text("Lifecycle: $lifecycleEvent")
    }
}
