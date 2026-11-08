import Testing
import Foundation
@testable import ClaudePenguin

@Suite struct ProtocolTests {
    @Test func stateEventWithUnknownFields() {
        let line = #"{"event":"state","state":"running","mode":"code","urls":{"game":"http://localhost:47080/","agents":"http://localhost:47081/","future":"x"},"message":"ok","extra":{"a":1}}"#
        guard case .event(.state(let s)) = ControllerMessage.parse(line) else { Issue.record("not a state event"); return }
        #expect(s.state == .running)
        #expect(s.mode == .code)
        #expect(s.urls?.agents == "http://localhost:47081/")
        #expect(s.message == "ok")
    }

    @Test func unknownStateSurvives() {
        let line = #"{"event":"state","state":"hibernating","mode":null}"#
        guard case .event(.state(let s)) = ControllerMessage.parse(line) else { Issue.record("not a state event"); return }
        #expect(s.state == .unknown("hibernating"))
        #expect(s.mode == nil)
    }

    @Test func unknownEventTypeIsTolerated() {
        #expect(ControllerMessage.parse(#"{"event":"telemetry","x":1}"#) == .event(.unknown("telemetry")))
    }

    @Test func progressServiceProblem() {
        if case .event(.progress(let p)) = ControllerMessage.parse(#"{"event":"progress","task":"media","label":"Game files","done":50,"total":200,"eta":9}"#) {
            #expect(p.fraction == 0.25)
            #expect(p.label == "Game files")
        } else { Issue.record("progress") }
        if case .event(.progress(let p)) = ControllerMessage.parse(#"{"event":"progress","task":"runtime","label":"x","done":3,"total":null}"#) {
            #expect(p.fraction == nil)
        } else { Issue.record("progress null total") }
        if case .event(.service(let s)) = ControllerMessage.parse(#"{"event":"service","name":"postgres","state":"healthy","pid":42}"#) {
            #expect(s.pid == 42)
        } else { Issue.record("service") }
        if case .event(.problem(let p)) = ControllerMessage.parse(#"{"event":"problem","code":"PORT_IN_USE","message":"busy","detail":{"port":47080}}"#) {
            #expect(p.code == "PORT_IN_USE")
            #expect(p.detail != nil)
        } else { Issue.record("problem") }
    }

    @Test func responses() {
        guard case .response(let ok) = ControllerMessage.parse(#"{"id":7,"ok":true,"result":{"state":"stopped","setupComplete":true,"sessions":{"running":2,"total":3},"novel":[1]}}"#) else {
            Issue.record("response"); return
        }
        #expect(ok.id == 7 && ok.ok)
        let status = ok.decodeResult(StatusResult.self)
        #expect(status?.state == .stopped)
        #expect(status?.setupComplete == true)
        #expect(status?.sessions?.running == 2)

        guard case .response(let bad) = ControllerMessage.parse(#"{"id":8,"ok":false,"error":{"code":"BUSY","message":"nope","more":1}}"#) else {
            Issue.record("error response"); return
        }
        #expect(!bad.ok)
        #expect(bad.error == ControllerError(code: "BUSY", message: "nope"))
    }

    @Test func preflight() {
        let json = #"{"id":1,"ok":true,"result":{"downloadBytes":4100000000,"requiredBytes":null,"freeBytes":100,"portConflicts":[{"port":47080,"service":"web","pid":9}],"problems":["low disk",{"code":"X","message":"object problem"}]}}"#
        guard case .response(let r) = ControllerMessage.parse(json), let p = r.decodeResult(PreflightResult.self) else {
            Issue.record("preflight"); return
        }
        #expect(p.downloadBytes == 4_100_000_000)
        #expect(p.requiredBytes == nil)
        #expect(p.portConflicts == [PortConflict(port: 47080, service: "web")])
        #expect(p.problems == ["low disk", "object problem"])
        #expect(!p.canProceed)
        #expect(PreflightResult(requiredBytes: 10, freeBytes: 20).canProceed)
        #expect(!PreflightResult(requiredBytes: 30, freeBytes: 20).canProceed)
    }

    @Test func garbageLines() {
        #expect(ControllerMessage.parse("not json") == .unrecognized("not json"))
        #expect(ControllerMessage.parse("{}") == .unrecognized("{}"))
    }
}
