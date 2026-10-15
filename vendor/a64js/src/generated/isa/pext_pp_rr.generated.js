export const ENCODINGS = [
    {
        "instructionId": "pext_pp_rr",
        "encodingId": "pext_pp_rr_",
        "mnemonic": "PEXT",
        "className": "SVE2",
        "fileName": "pext_pp_rr.xml",
        "mask": 4282383888,
        "value": 622883856,
        "bitCount": 22,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "i1",
                "lsb": 8,
                "width": 1
            },
            {
                "name": "PNn",
                "lsb": 5,
                "width": 3
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SME2 || FEAT_SVE2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-pext"
    }
];
